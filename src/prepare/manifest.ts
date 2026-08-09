import ts from "typescript";

import { PlanValidationError } from "../errors.ts";
import { byCodeUnit, hashJson, hashText, isFileState, isSha256, stableStringify, type FileState } from "../util/hash.ts";
import {
  PREPARATION_MANIFEST_SCHEMA_VERSION,
  type CompatibilityReexportIntent,
  type ExtractTypeDeclarationsOperation,
  type PreparationDeclarationGroupSelector,
  type PreparationDeclarationSelector,
  type PreparationManifest,
  type PreparationManifestDraft,
  type PreparationReplayOperation,
  type PreparationTargetDeclarationProof,
  type PreparationValidationIssue,
  type PreparationValidationResult,
  type ValidatePreparationManifestOptions,
} from "./manifest-types.ts";
import { validateDeletionRecipe, validatePortPackageExportRecipe, validateReplayRecipe, validateRewriteRecipe } from "./manifest-recipe.ts";

const COMMIT_HASH = /^[0-9a-f]{7,64}$/;
const COMMIT_SUBJECT = /^(?:refactor|fix|feat|chore|test|docs|ci|build|perf|style)(?:\([^)\n]+\))?!?: [^\n]+$/;

/** Builds the deterministic identity from every manifest field except planId. */
export function preparationPlanId(draft: PreparationManifestDraft): string {
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
  return operation.kind === "extract-type-declarations"
    ? [operation.donor.path, operation.target.path]
    : [operation.file.path];
}

/**
 * Checks only supplied data; it never reads the repository. A caller that
 * supplies current file states or contents receives stale-input detection
 * without coupling this structural layer to filesystem access.
 */
export function validatePreparationManifest(
  manifest: PreparationManifest,
  options: ValidatePreparationManifestOptions = {},
): PreparationValidationResult {
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
export function assertPreparationManifestValid(
  manifest: PreparationManifest,
  options: ValidatePreparationManifestOptions = {},
): void {
  const result = validatePreparationManifest(manifest, options);
  if (result.ok) return;
  throw new PlanValidationError(
    `preparation plan ${manifest.planId} failed validation with ${result.issues.length} error(s):\n${result.issues.map((issue) => `  [${issue.rule}] ${issue.message}`).join("\n")}`,
    result.issues.map((issue) => issue.message),
  );
}

type AddIssue = (rule: string, message: string, path?: string) => void;

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
  const groupIds = new Set<string>();
  const groupNames = new Set<string>();
  const declarationIds = new Set<string>();
  const spansByPath = new Map<string, PreparationDeclarationSelector[]>();
  const extractionRegionsByPath = new Map<string, PreparationDeclarationSelector[]>();
  for (const group of groups) {
    const groupLabel = `${group.sourcePath}\u0000${group.name}`;
    if (groupIds.has(group.groupId)) add("declaration-group", `duplicate declaration group ${group.groupId}`, group.sourcePath);
    groupIds.add(group.groupId);
    if (groupNames.has(groupLabel)) add("declaration-group", `ambiguous groups share ${group.name} in ${group.sourcePath}`, group.sourcePath);
    groupNames.add(groupLabel);
    if (!isWorkspacePath(group.sourcePath)) add("declaration-path", "declaration group sourcePath must be workspace-relative", group.sourcePath);
    if (!group.name || group.space !== "type") add("declaration-group", "declaration groups must have a non-empty name and type-only space", group.sourcePath);
    if (group.declarations.length === 0) add("declaration-group", "declaration groups cannot be empty", group.sourcePath);
    if (group.groupId !== hashJson({ sourcePath: group.sourcePath, name: group.name, declarationIds: group.declarations.map((item) => item.declarationId) })) {
      add("declaration-group", `group id for ${group.name} does not match its declaration identities`, group.sourcePath);
    }
    validateSorted(group.declarations, declarationKey, "declaration-order", `declarations in ${group.name} must be span-sorted`, add);
    for (const declaration of group.declarations) {
      validateDeclaration(declaration, group, add);
      if (declarationIds.has(declaration.declarationId)) add("declaration", `duplicate declaration ${declaration.declarationId}`, declaration.sourcePath);
      declarationIds.add(declaration.declarationId);
      const spans = spansByPath.get(declaration.sourcePath) ?? [];
      spans.push(declaration);
      spansByPath.set(declaration.sourcePath, spans);
      const extractions = extractionRegionsByPath.get(declaration.sourcePath) ?? [];
      extractions.push(declaration);
      extractionRegionsByPath.set(declaration.sourcePath, extractions);
    }
  }
  for (const [path, declarations] of spansByPath) {
    const ordered = [...declarations].sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end || byCodeUnit(left.declarationId, right.declarationId));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (current.span.start < previous.span.end) add("declaration-span", `declaration span for ${current.name} overlaps ${previous.name}`, path);
    }
  }
  for (const [path, declarations] of extractionRegionsByPath) {
    const ordered = [...declarations].sort((left, right) => left.extractionStart - right.extractionStart || left.extractionEnd - right.extractionEnd || byCodeUnit(left.selectorId, right.selectorId));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (current.extractionStart < previous.extractionEnd) add("extraction-region", `extraction region for ${current.name} overlaps ${previous.name}`, path);
    }
  }
}

function validateDeclaration(declaration: PreparationDeclarationSelector, group: PreparationDeclarationGroupSelector, add: AddIssue): void {
  if (!isWorkspacePath(declaration.sourcePath)) add("declaration-path", "declaration sourcePath must be workspace-relative", declaration.sourcePath);
  if (!isSha256(declaration.declarationId) || !isSha256(declaration.selectorId) || !isSha256(declaration.sourceHash) || !isSha256(declaration.span?.hash ?? "") || !isSha256(declaration.extractionHash)) add("declaration-hash", "declaration, selector, source, span, and extraction hashes must be SHA-256 values", declaration.sourcePath);
  if (declaration.sourcePath !== group.sourcePath || declaration.name !== group.name || declaration.space !== "type") add("declaration-group", "every group member must match its group source, name, and type-only space", declaration.sourcePath);
  if (typeof declaration.originallyExported !== "boolean") add("declaration-export", "declaration originallyExported must be boolean", declaration.sourcePath);
  if (declaration.kind !== "interface" && declaration.kind !== "type-alias") add("declaration-kind", "only interfaces and type aliases are eligible for type-only extraction", declaration.sourcePath);
  if (!Number.isInteger(declaration.span?.start) || !Number.isInteger(declaration.span?.end) || declaration.span.start < 0 || declaration.span.end <= declaration.span.start) add("declaration-span", "declaration span must be a non-empty pair of UTF-16 offsets", declaration.sourcePath);
  if (declaration.declarationId !== hashJson({ sourcePath: declaration.sourcePath, name: declaration.name, kind: declaration.kind, start: declaration.span.start, end: declaration.span.end, spanHash: declaration.span.hash })) {
    add("declaration-id", `declaration id for ${declaration.name} does not match its selector`, declaration.sourcePath);
  }
  if (!Number.isInteger(declaration.extractionStart) || !Number.isInteger(declaration.extractionEnd) || declaration.extractionStart < 0 || declaration.extractionEnd < declaration.extractionStart || declaration.extractionStart > declaration.span.start || declaration.extractionEnd < declaration.span.end) {
    add("extraction-region", "extraction region must contain its declaration span", declaration.sourcePath);
  }
  if (declaration.selectorId !== selectorId(declaration)) add("selector-id", `selector id for ${declaration.name} does not match its removal recipe`, declaration.sourcePath);
}

function validateOperations(manifest: PreparationManifest, add: AddIssue): void {
  if (manifest.operations.length === 0) add("operations", "operations must not be empty");
  validateSorted(manifest.operations, operationKey, "operation-order", "operations must be deterministically ordered", add);
  const mutationPaths = new Set<string>();
  const groupById = new Map(manifest.declarations.map((group) => [group.groupId, group]));
  const includedGroups = new Set<string>();
  for (const operation of manifest.operations) {
    for (const path of preparationOperationPaths(operation)) {
      if (!isWorkspacePath(path)) add("operation-path", "operation path must be workspace-relative", path);
      if (mutationPaths.has(path)) add("operation-path", `multiple operations mutate ${path}`, path);
      mutationPaths.add(path);
    }
    if (operation.kind === "write-file") {
      validateMutation(operation.file, operation.contents, "write-file", add);
      continue;
    }
    if (operation.kind === "rewrite-module-specifier") {
      validateMutation(operation.file, operation.contents, "rewrite-specifier", add);
      validateRewriteRecipe(operation, add);
      continue;
    }
    if (operation.kind === "delete-module") {
      validateDeletionRecipe(operation, manifest.operations, add);
      continue;
    }
    if (operation.kind === "adopt-generated-source") {
      validateMutation(operation.file, operation.contents, "generated-source-adoption", add);
      if (!isWorkspacePath(operation.declaredSource) || operation.file.preconditionHash === "missing" || operation.file.preconditionMode === "missing" || operation.removedHeader.lines < 1 || !isSha256(operation.removedHeader.hash)) add("generated-source-adoption", "adoption must bind an existing artifact, missing source path, and exact removed header", operation.file.path);
      continue;
    }
    if (operation.kind === "delete-generated-source-generator") {
      if (operation.file.preconditionHash === "missing" || operation.file.preconditionMode === "missing" || operation.adoptedOutputs.length === 0) add("generated-source-generator", "generator retirement requires an existing generator and adopted output proof", operation.file.path);
      validateSortedStrings(operation.adoptedOutputs, "generated-source-generator", "adoptedOutputs", add);
      continue;
    }
    validateExtractOperation(operation, groupById, includedGroups, add);
  }
  validatePortPackageExportRecipe(manifest.operations, add);
  if (includedGroups.size !== groupById.size) add("operation-declarations", "operations must include every declared extraction group exactly once");
}

function validateExtractOperation(
  operation: ExtractTypeDeclarationsOperation,
  groupById: ReadonlyMap<string, PreparationDeclarationGroupSelector>,
  includedGroups: Set<string>,
  add: AddIssue,
): void {
  if (operation.donor.path === operation.target.path) add("extract-paths", "donor and target paths must differ", operation.donor.path);
  if (!isSha256(operation.donor.preconditionHash) || operation.target.preconditionHash !== "missing") add("extract-precondition", "an extraction donor must have a SHA-256 precondition and its new target must be missing", operation.donor.path);
  if (operation.donor.preconditionMode !== operation.donor.resultMode) add("extract-mode", "donor rewrite must preserve its baseline mode", operation.donor.path);
  if (!isModuleSpecifier(operation.moduleSpecifier)) add("extract-specifier", "extraction moduleSpecifier must be a non-empty, non-traversing module specifier", operation.donor.path);
  validateMutation(operation.donor, operation.donorContents, "extract-donor", add);
  validateMutation(operation.target, operation.targetContents, "extract-target", add);
  validateReplayRecipe(operation, add);
  validateTargetDeclarationProofs(operation, add);
  if (operation.declarations.length === 0) add("extract-declarations", "an extraction must contain at least one complete group", operation.donor.path);
  validateSorted(operation.declarations, groupKey, "extract-declaration-order", "extracted declaration groups must be deterministically ordered", add);
  for (const group of operation.declarations) {
    const expected = groupById.get(group.groupId);
    if (!expected || hashJson(expected) !== hashJson(group)) add("extract-declarations", `extraction group ${group.groupId} does not match a declared selector`, operation.donor.path);
    if (includedGroups.has(group.groupId)) add("extract-declarations", `declaration group ${group.groupId} is extracted more than once`, operation.donor.path);
    includedGroups.add(group.groupId);
    for (const declaration of group.declarations) {
      if (declaration.sourcePath !== operation.donor.path || declaration.sourceHash !== operation.donor.preconditionHash) add("extract-selector", "every selector must bind to the donor path and precondition hash", operation.donor.path);
    }
  }
}

function validateTargetDeclarationProofs(operation: ExtractTypeDeclarationsOperation, add: AddIssue): void {
  const selectors = operation.declarations.flatMap((group) => group.declarations);
  const selectorsById = new Map(selectors.map((selector) => [selector.selectorId, selector]));
  validateSorted(operation.targetDeclarationProofs, (proof) => proof.selectorId, "target-declaration-order", "target declaration proofs must be deterministically ordered and unique", add);
  if (operation.targetDeclarationProofs.length !== selectors.length) add("target-declaration-proof", "target declaration proofs must cover every extracted selector exactly once", operation.target.path);
  const proofs = new Set<string>();
  const regions: PreparationTargetDeclarationProof[] = [];
  const target = ts.createSourceFile(operation.target.path, operation.targetContents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const proof of operation.targetDeclarationProofs) {
    if (proofs.has(proof.selectorId)) add("target-declaration-proof", `duplicate target declaration proof for ${proof.selectorId}`, operation.target.path);
    proofs.add(proof.selectorId);
    regions.push(proof);
    const selector = selectorsById.get(proof.selectorId);
    if (!selector) {
      add("target-declaration-proof", `target declaration proof has no extracted selector: ${proof.selectorId}`, operation.target.path);
      continue;
    }
    if (!isSha256(proof.targetHash) || !isSha256(proof.targetExtractionHash) || !Number.isInteger(proof.targetStart) || !Number.isInteger(proof.targetEnd) || !Number.isInteger(proof.targetExtractionStart) || !Number.isInteger(proof.targetExtractionEnd) || proof.targetStart < 0 || proof.targetEnd <= proof.targetStart || proof.targetEnd > operation.targetContents.length || proof.targetExtractionStart < 0 || proof.targetExtractionEnd < proof.targetExtractionStart || proof.targetExtractionEnd > operation.targetContents.length || proof.targetExtractionStart > proof.targetStart || proof.targetExtractionEnd < proof.targetEnd) {
      add("target-declaration-proof", `target declaration proof for ${selector.name} has an invalid span or hash`, operation.target.path);
      continue;
    }
    if (hashText(operation.targetContents.slice(proof.targetStart, proof.targetEnd)) !== proof.targetHash) {
      add("target-declaration-proof", `target declaration hash for ${selector.name} does not match target replay bytes`, operation.target.path);
      continue;
    }
    if (hashText(operation.targetContents.slice(proof.targetExtractionStart, proof.targetExtractionEnd)) !== proof.targetExtractionHash) {
      add("target-declaration-proof", `target extraction hash for ${selector.name} does not match target replay bytes`, operation.target.path);
      continue;
    }
    const statement = target.statements.find((item) => item.getStart(target) === proof.targetStart && item.end === proof.targetEnd);
    if (!statement || statement.getFullStart() !== proof.targetExtractionStart || statement.end !== proof.targetExtractionEnd || !matchesTargetSelector(statement, selector.name, selector.kind)) {
      add("target-declaration-proof", `target declaration proof for ${selector.name} does not name its rendered type declaration`, operation.target.path);
      continue;
    }
    const exported = hasExportModifier(statement);
    if (typeof proof.synthesizedExport !== "boolean" || exported !== (selector.originallyExported || proof.synthesizedExport) || (proof.synthesizedExport && selector.originallyExported)) {
      add("target-declaration-proof", `target export proof for ${selector.name} does not match the rendered declaration`, operation.target.path);
    }
  }
  for (const selector of selectors) if (!proofs.has(selector.selectorId)) add("target-declaration-proof", `missing target declaration proof for ${selector.name}`, operation.target.path);
  const ordered = [...regions].sort((left, right) => left.targetExtractionStart - right.targetExtractionStart || left.targetExtractionEnd - right.targetExtractionEnd || byCodeUnit(left.selectorId, right.selectorId));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.targetExtractionStart < previous.targetExtractionEnd) add("target-declaration-proof", "target declaration extraction regions must not overlap", operation.target.path);
  }
}

function matchesTargetSelector(statement: ts.Statement, name: string, kind: PreparationDeclarationSelector["kind"]): boolean {
  return (kind === "interface" && ts.isInterfaceDeclaration(statement) && statement.name.text === name)
    || (kind === "type-alias" && ts.isTypeAliasDeclaration(statement) && statement.name.text === name);
}

function hasExportModifier(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function validateMutation(mutation: { readonly path: string; readonly preconditionHash: FileState; readonly preconditionMode: number | "missing"; readonly resultHash: string; readonly resultMode: number }, contents: string, rule: string, add: AddIssue): void {
  if (!isFileState(mutation.preconditionHash) || !isSha256(mutation.resultHash)) add(rule, "file mutation hashes are invalid", mutation.path);
  if ((mutation.preconditionHash === "missing") !== (mutation.preconditionMode === "missing")) add(`${rule}-mode`, "preconditionMode must be missing exactly when the precondition hash is missing", mutation.path);
  if (mutation.preconditionMode !== "missing" && !isFileMode(mutation.preconditionMode)) add(`${rule}-mode`, "preconditionMode must be canonical Git mode 0644 or 0755", mutation.path);
  if (!isFileMode(mutation.resultMode)) add(`${rule}-mode`, "resultMode must be canonical Git mode 0644 or 0755", mutation.path);
  if (hashText(contents) !== mutation.resultHash) add(rule, "resultHash does not match replay contents", mutation.path);
}

function validateCompatibility(manifest: PreparationManifest, add: AddIssue): void {
  validateSorted(manifest.compatibilityReexports, compatibilityKey, "compatibility-order", "compatibility re-exports must be deterministically ordered", add);
  const operations = manifest.operations.filter((item): item is ExtractTypeDeclarationsOperation => item.kind === "extract-type-declarations");
  const seen = new Set<string>();
  for (const intent of manifest.compatibilityReexports) {
    const key = compatibilityKey(intent);
    if (seen.has(key)) add("compatibility", `duplicate compatibility re-export ${intent.fromPath} -> ${intent.toPath}`, intent.fromPath);
    seen.add(key);
    if (!isWorkspacePath(intent.fromPath) || !isWorkspacePath(intent.toPath) || intent.fromPath === intent.toPath) add("compatibility", "compatibility paths must be distinct workspace-relative paths", intent.fromPath);
    if (!isModuleSpecifier(intent.moduleSpecifier)) add("compatibility-specifier", "compatibility moduleSpecifier must be a non-empty, non-traversing module specifier", intent.fromPath);
    const extraction = operations.find((operation) => operation.donor.path === intent.fromPath && operation.target.path === intent.toPath);
    if (!extraction) add("compatibility", "compatibility re-export must correspond to an extraction donor and target", intent.fromPath);
    validateSortedStrings(intent.exports.map((item) => item.name), "compatibility-exports", "compatibility exports", add);
    if (intent.exports.some((item) => item.typeOnly !== true || !item.name)) add("compatibility-exports", "compatibility exports must be non-empty type-only names", intent.fromPath);
    if (extraction) {
      if (intent.moduleSpecifier !== extraction.moduleSpecifier) add("compatibility-specifier", "compatibility moduleSpecifier must match its extraction replay specifier", intent.fromPath);
      const available = new Set(extraction.declarations.map((group) => group.name));
      for (const exported of intent.exports) if (!available.has(exported.name)) add("compatibility-exports", `${exported.name} is not selected by the matching extraction`, intent.fromPath);
    }
  }
  for (const extraction of operations) {
    const intents = manifest.compatibilityReexports.filter((intent) => intent.fromPath === extraction.donor.path && intent.toPath === extraction.target.path);
    const expected = extraction.declarations
      .filter((group) => group.declarations.some((declaration) => declaration.originallyExported))
      .map((group) => group.name)
      .sort(byCodeUnit);
    if (expected.length === 0 && intents.length > 0) add("compatibility-exports", "private-only extraction must not declare a compatibility re-export", extraction.donor.path);
    if (expected.length > 0 && intents.length !== 1) {
      add("compatibility-exports", "every extracted public type group requires exactly one compatibility re-export", extraction.donor.path);
      continue;
    }
    const actual = intents[0]?.exports.map((item) => item.name) ?? [];
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) add("compatibility-exports", "compatibility exports must exactly equal the extracted public type groups", extraction.donor.path);
  }
}

function validateScope(manifest: PreparationManifest, add: AddIssue): void {
  const artifacts = manifest.generatedArtifacts ?? [];
  validateSorted(artifacts, (item) => item.path, "generated-artifact-order", "generatedArtifacts must be path-sorted", add);
  for (const artifact of artifacts) {
    if (!isWorkspacePath(artifact.path) || !isWorkspacePath(artifact.source)) add("generated-artifact", "generated artifact paths must be workspace-relative", artifact.path);
    if (!artifact.regenerate) add("generated-artifact", "generated artifact regenerate command must be non-empty", artifact.path);
    if (artifact.regenerateOnApply !== true) add("generated-artifact", "generated artifact must declare regenerateOnApply true", artifact.path);
    if (artifact.exemptReason !== undefined && artifact.exemptReason.length === 0) add("generated-artifact", "generated artifact exemptReason must be non-empty when present", artifact.path);
  }
  const paths = [...new Set([
    ...manifest.operations.flatMap(preparationOperationPaths),
    ...artifacts.map((item) => item.path),
    ...(manifest.postJournalPreparers ?? []).flatMap((item) => item.outputs),
  ])].sort(byCodeUnit);
  validateSortedStrings(manifest.changedFiles, "changed-files", "changedFiles", add);
  if (paths.length !== manifest.changedFiles.length || paths.some((path, index) => path !== manifest.changedFiles[index])) add("changed-files", "changedFiles must exactly equal the sorted union of operation, generated-artifact, and post-journal mutation paths");
}

function validateLiveState(manifest: PreparationManifest, options: ValidatePreparationManifestOptions, add: AddIssue): void {
  if (options.expectedGraphDigest !== undefined && !isSha256(options.expectedGraphDigest)) {
    add("expected-graph-digest", "expectedGraphDigest must be a SHA-256 hash");
  } else if (options.expectedGraphDigest !== undefined && manifest.graphDigest !== options.expectedGraphDigest) {
    add("graph-digest", "graphDigest does not match the expected fresh workspace graph");
  }
  if (options.currentFiles) {
    for (const operation of manifest.operations) {
      const mutations = operation.kind === "extract-type-declarations" ? [operation.donor, operation.target] : [operation.file];
      for (const mutation of mutations) {
        const actual = options.currentFiles[mutation.path];
        if (actual === undefined) add("stale-input", `no supplied current state for ${mutation.path}`, mutation.path);
        else if (actual !== mutation.preconditionHash) add("stale-input", `current state differs from ${mutation.path}'s precondition`, mutation.path);
      }
    }
  }
  if (options.currentContents) {
    for (const group of manifest.declarations) for (const declaration of group.declarations) {
      const contents = options.currentContents[declaration.sourcePath];
      if (contents === undefined) {
        add("stale-selector", `no supplied source text for ${declaration.sourcePath}`, declaration.sourcePath);
        continue;
      }
      if (hashText(contents) !== declaration.sourceHash) add("stale-selector", "current source hash differs from declaration selector", declaration.sourcePath);
      if (declaration.span.end > contents.length || hashText(contents.slice(declaration.span.start, declaration.span.end)) !== declaration.span.hash) add("stale-selector", `span hash for ${declaration.name} no longer matches source text`, declaration.sourcePath);
      validateCurrentExtractionRegion(contents, declaration, add);
    }
  }
}

function withoutPlanId(manifest: PreparationManifest): PreparationManifestDraft {
  const { planId: _planId, ...draft } = manifest;
  return draft;
}

function groupKey(group: PreparationDeclarationGroupSelector): string {
  const first = group.declarations[0];
  return `${group.sourcePath}\u0000${String(first?.span.start ?? -1).padStart(12, "0")}\u0000${group.groupId}`;
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

function validateSorted<T>(values: readonly T[], key: (value: T) => string, rule: string, message: string, add: AddIssue): void {
  for (let index = 1; index < values.length; index += 1) if (byCodeUnit(key(values[index - 1]!), key(values[index]!)) >= 0) add(rule, message);
}

function validateSortedStrings(values: readonly string[] | undefined, rule: string, label: string, add: AddIssue): void {
  if (!values) {
    add(rule, `${label} must be an array`);
    return;
  }
  for (const value of values) if (typeof value !== "string" || value.length === 0) add(rule, `${label} entries must be non-empty strings`);
  for (let index = 1; index < values.length; index += 1) if (byCodeUnit(values[index - 1]!, values[index]!) >= 0) add(rule, `${label} must be sorted and unique`);
}

function isWorkspacePath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("\\") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** Relative specifiers may begin with `./` or any number of `../` segments. */
function isModuleSpecifier(specifier: string): boolean {
  if (typeof specifier !== "string" || specifier.length === 0 || /[\\\r\n\u0000]/.test(specifier) || specifier.startsWith("/")) return false;
  if (!specifier.startsWith(".")) return true;
  const segments = specifier.split("/");
  let index = 0;
  if (segments[0] === ".") index = 1;
  while (segments[index] === "..") index += 1;
  if (index === 0 || index === segments.length) return false;
  return segments.slice(index).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}


function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isFileMode(value: number): boolean {
  return value === 0o644 || value === 0o755;
}
