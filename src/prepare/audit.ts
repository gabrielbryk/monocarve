/** Independent, post-apply proofs for a type-only preparation manifest. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { MonocarveConfig } from "../config.ts";
import { fileState } from "../util/files.ts";
import { showBaselineBytes } from "../util/git.ts";
import { hashBytes, hashJson, hashText, MISSING, type FileState } from "../util/hash.ts";
import { normalizePath, workspacePath } from "../util/paths.ts";
// The boundary-specific proofs (retainedRootClearance / adapterSurfaceParity)
// live in their own module purely to keep this file under the line-count gate.
import { computeBoundaryAuditProofs } from "./audit-boundary.ts";
import { verifyGeneratedSourceOperations } from "./audit-generated-source.ts";
import { verifyTargetImportProofs } from "./audit-imports.ts";
import { verifyPreparationResultModes } from "./audit-modes.ts";
import { verifyRenderedReplay } from "./audit-replay.ts";
// The changed-path scope proof lives in its own module for the same reason.
import { verifyChangedScope } from "./audit-scope.ts";
import { verifyCompatibilityResolution, verifyRenderedCompatibilitySurface, verifyTargetDeclarationCoverage } from "./audit-surface.ts";
import type { PreparationAuditOptions, PreparationAuditReport } from "./audit-types.ts";
import { preparationProof } from "./audit-types.ts";
import type {
  CompatibilityReexportIntent,
  ExtractTypeDeclarationsOperation,
  PreparationDeclarationGroupSelector,
  PreparationDeclarationSelector,
  PreparationReplayOperation,
} from "./manifest-types.ts";
export type { PreparationAuditOptions, PreparationAuditReport } from "./audit-types.ts";
export async function auditPreparation(options: PreparationAuditOptions): Promise<PreparationAuditReport> {
  return auditPreparationSync(options);
}
/**
 * Prove this exact preparation landed from its immutable baseline.
 *
 * A failure would mean either the declared replay bytes were changed, the
 * declaration selectors no longer name one physical type declaration each, a
 * compatibility edge lies about its surface, or another path changed. None of
 * these proofs asserts semantic equivalence beyond that narrow statement.
 */
export function auditPreparationSync(options: PreparationAuditOptions): PreparationAuditReport {
  const { manifest, rootDir } = options;
  const extracts = manifest.operations.filter(isExtract);
  const byteFailures: string[] = [];
  const modeFailures: string[] = [];
  const replayFailures: string[] = [];
  const selectorFailures: string[] = [];
  const ownershipFailures: string[] = [];
  const compatibilityFailures: string[] = [];
  const importFailures: string[] = [];
  const scopeFailures: string[] = [];
  const typeValueFailures: string[] = [];
  const graphFailures: string[] = [];
  const generatedFailures: string[] = [];

  const baselineByPath = new Map<string, Uint8Array>();
  for (const operation of extracts) {
    verifyMutationBytes(rootDir, manifest.baseline.commit, operation, baselineByPath, byteFailures);
  }
  const modeChecks = verifyPreparationResultModes(rootDir, manifest.operations, modeFailures);
  for (const operation of manifest.operations)
    if (operation.kind === "write-file") verifyWriteBytes(rootDir, manifest.baseline.commit, operation, byteFailures);
  verifyGeneratedSourceOperations(rootDir, manifest.baseline.commit, manifest.operations, byteFailures);
  for (const operation of extracts) verifyRenderedReplay(operation, baselineByPath.get(operation.donor.path), replayFailures);

  const selectors = extracts.flatMap((operation) => operation.declarations.flatMap((group) => group.declarations));
  verifySelectors(selectors, baselineByPath, selectorFailures);
  verifyOwnership(rootDir, manifest.declarations, extracts, baselineByPath, ownershipFailures);
  verifyTypeOnlyOperations(rootDir, extracts, typeValueFailures);
  verifyCompatibility(rootDir, options.config, manifest.compatibilityReexports, extracts, compatibilityFailures, typeValueFailures);
  verifyTargetImportProofs(rootDir, options.config, extracts, baselineByPath, importFailures);
  const provenancePath = options.approvedManifestPath === undefined ? undefined : normalizePath(options.approvedManifestPath);
  verifyChangedScope(rootDir, manifest.baseline.commit, manifest.changedFiles, provenancePath, scopeFailures, [
    ...(manifest.generatedArtifacts ?? []).filter((item) => item.exemptReason !== undefined).map((item) => item.path),
    ...(manifest.postJournalPreparers ?? []).flatMap((item) => item.outputs),
  ]);
  if (options.freshGraph.commit !== manifest.baseline.commit) {
    graphFailures.push("fresh graph commit does not match the preparation baseline");
  }
  if (options.freshGraph.digest !== manifest.graphDigest) {
    graphFailures.push("manifest graph digest does not match the fresh graph evidence");
  }
  const { retainedRootClearance, adapterSurfaceParity } = computeBoundaryAuditProofs(rootDir, manifest.operations);
  for (const artifact of manifest.generatedArtifacts ?? []) {
    const current = fileState(workspacePath(rootDir, artifact.path));
    if (current === MISSING) generatedFailures.push(`declared generated artifact is missing: ${artifact.path}`);
    const observed = options.regeneratedArtifacts?.[artifact.path];
    if (options.regeneratedArtifacts !== undefined && observed === undefined)
      generatedFailures.push(`generator replay supplied no freshness hash for ${artifact.path}`);
    else if (observed !== undefined && current !== observed) generatedFailures.push(`generated artifact changed after regeneration: ${artifact.path}`);
  }

  const byteReplay = preparationProof(byteFailures, extracts.length * 5 + manifest.operations.filter((item) => item.kind === "write-file").length * 3);
  const fileModes = preparationProof(modeFailures, modeChecks);
  const renderedReplay = preparationProof(replayFailures, extracts.length);
  const selectorIntegrity = preparationProof(selectorFailures, selectors.length);
  const declarationOwnership = preparationProof(ownershipFailures, manifest.declarations.length);
  const compatibilitySurface = preparationProof(compatibilityFailures, manifest.compatibilityReexports.length);
  const targetImportResolution = preparationProof(
    importFailures,
    extracts.reduce((total, item) => total + item.targetImportProofs.length, 0),
  );
  const changedPathScope = preparationProof(scopeFailures, manifest.changedFiles.length);
  const typeValueClaims = preparationProof(typeValueFailures, extracts.length + manifest.compatibilityReexports.length);
  const graphDigest = preparationProof(graphFailures, 2);
  const generatedArtifactFreshness = preparationProof(generatedFailures, (manifest.generatedArtifacts ?? []).length);
  const failures = [
    ...byteReplay.failures,
    ...fileModes.failures,
    ...renderedReplay.failures,
    ...selectorIntegrity.failures,
    ...declarationOwnership.failures,
    ...compatibilitySurface.failures,
    ...targetImportResolution.failures,
    ...changedPathScope.failures,
    ...typeValueClaims.failures,
    ...graphDigest.failures,
    ...generatedArtifactFreshness.failures,
    ...retainedRootClearance.failures,
    ...adapterSurfaceParity.failures,
  ];
  return {
    planId: manifest.planId,
    baselineCommit: manifest.baseline.commit,
    auditedRoot: resolve(rootDir),
    passed: failures.length === 0,
    byteReplay,
    fileModes,
    renderedReplay,
    selectorIntegrity,
    declarationOwnership,
    compatibilitySurface,
    targetImportResolution,
    changedPathScope,
    typeValueClaims,
    graphDigest,
    generatedArtifactFreshness,
    retainedRootClearance,
    adapterSurfaceParity,
    failures,
  };
}

function isExtract(operation: PreparationReplayOperation): operation is ExtractTypeDeclarationsOperation {
  return operation.kind === "extract-type-declarations";
}

function verifyMutationBytes(
  rootDir: string,
  baseline: string,
  operation: ExtractTypeDeclarationsOperation,
  baselines: Map<string, Uint8Array>,
  failures: string[],
): void {
  const donorBaseline = showBaselineBytes(rootDir, baseline, operation.donor.path);
  if (donorBaseline === null) {
    failures.push(`baseline donor does not exist: ${operation.donor.path}`);
  } else {
    baselines.set(operation.donor.path, donorBaseline);
    const actual = hashBytes(donorBaseline);
    if (actual !== operation.donor.preconditionHash) {
      failures.push(`baseline donor hash differs: ${operation.donor.path}`);
    }
  }
  verifyBaselineHash(rootDir, baseline, operation.target.path, operation.target.preconditionHash, failures);
  if (hashText(operation.donorContents) !== operation.donor.resultHash) {
    failures.push(`declared donor contents hash differs: ${operation.donor.path}`);
  }
  if (hashText(operation.targetContents) !== operation.target.resultHash) {
    failures.push(`declared target contents hash differs: ${operation.target.path}`);
  }
  verifyCurrentHash(rootDir, operation.donor.path, operation.donor.resultHash, failures);
  verifyCurrentHash(rootDir, operation.target.path, operation.target.resultHash, failures);
}

function verifyWriteBytes(
  rootDir: string,
  baseline: string,
  operation: Extract<PreparationReplayOperation, { readonly kind: "write-file" }>,
  failures: string[],
): void {
  if (hashText(operation.contents) !== operation.file.resultHash) {
    failures.push(`declared write contents hash differs: ${operation.file.path}`);
  }
  // A claimed "new" compatibility or wiring file must not have overwritten a
  // baseline file. Comparing the final bytes alone cannot expose that bug.
  verifyBaselineHash(rootDir, baseline, operation.file.path, operation.file.preconditionHash, failures);
  verifyCurrentHash(rootDir, operation.file.path, operation.file.resultHash, failures);
}

function verifyCurrentHash(rootDir: string, path: string, expected: FileState, failures: string[]): void {
  const current = stateAt(rootDir, path);
  if (current !== expected) failures.push(`landed bytes differ: ${path} (expected ${expected}, got ${current})`);
}

function verifyBaselineHash(rootDir: string, baseline: string, path: string, expected: FileState, failures: string[]): void {
  const contents = showBaselineBytes(rootDir, baseline, path);
  const actual = contents === null ? MISSING : hashBytes(contents);
  if (actual !== expected) failures.push(`baseline state differs: ${path} (expected ${expected}, got ${actual})`);
}

function stateAt(rootDir: string, path: string): FileState {
  const absolute = workspacePath(rootDir, path);
  return existsSync(absolute) ? hashBytes(readFileSync(absolute)) : MISSING;
}

function verifySelectors(selectors: readonly PreparationDeclarationSelector[], baselines: ReadonlyMap<string, Uint8Array>, failures: string[]): void {
  const ids = new Set<string>();
  const selectorIds = new Set<string>();
  const spans = new Set<string>();
  for (const selector of selectors) {
    if (ids.has(selector.declarationId)) failures.push(`selector names declaration more than once: ${selector.declarationId}`);
    ids.add(selector.declarationId);
    if (selectorIds.has(selector.selectorId)) failures.push(`selector removal recipe appears more than once: ${selector.selectorId}`);
    selectorIds.add(selector.selectorId);
    const spanKey = `${selector.sourcePath}:${selector.span.start}:${selector.span.end}`;
    if (spans.has(spanKey)) failures.push(`selector claims a physical span more than once: ${spanKey}`);
    spans.add(spanKey);
    if (selector.space !== "type" || !isTypeKind(selector.kind)) {
      failures.push(`selector is not type-only: ${selector.sourcePath}:${selector.name}`);
    }
    const baseline = baselines.get(selector.sourcePath);
    if (baseline === undefined) {
      failures.push(`selector donor was not replayed: ${selector.sourcePath}`);
      continue;
    }
    const text = new TextDecoder().decode(baseline);
    if (hashText(text) !== selector.sourceHash) failures.push(`selector source hash differs: ${selector.sourcePath}:${selector.name}`);
    if (
      selector.selectorId !==
      hashJson({
        declarationId: selector.declarationId,
        sourcePath: selector.sourcePath,
        sourceHash: selector.sourceHash,
        extractionStart: selector.extractionStart,
        extractionEnd: selector.extractionEnd,
        extractionHash: selector.extractionHash,
      })
    ) {
      failures.push(`selector removal identity differs: ${selector.sourcePath}:${selector.name}`);
    }
    if (selector.span.start < 0 || selector.span.end <= selector.span.start || selector.span.end > text.length) {
      failures.push(`selector span is outside baseline donor: ${selector.sourcePath}:${selector.name}`);
      continue;
    }
    if (hashText(text.slice(selector.span.start, selector.span.end)) !== selector.span.hash) {
      failures.push(`selector span hash differs: ${selector.sourcePath}:${selector.name}`);
    }
    if (
      selector.extractionStart < 0 ||
      selector.extractionEnd < selector.span.end ||
      selector.extractionStart > selector.span.start ||
      selector.extractionEnd > text.length
    ) {
      failures.push(`selector extraction region is outside baseline donor: ${selector.sourcePath}:${selector.name}`);
      continue;
    }
    if (hashText(text.slice(selector.extractionStart, selector.extractionEnd)) !== selector.extractionHash) {
      failures.push(`selector extraction hash differs: ${selector.sourcePath}:${selector.name}`);
      continue;
    }
    const source = ts.createSourceFile(selector.sourcePath, text, ts.ScriptTarget.Latest, true);
    const statement = source.statements.find((item) => item.getStart(source) === selector.span.start && item.end === selector.span.end);
    if (!statement || statement.getFullStart() !== selector.extractionStart || statement.end !== selector.extractionEnd) {
      failures.push(`selector extraction region is not one full declaration: ${selector.sourcePath}:${selector.name}`);
    }
  }
}

function verifyOwnership(
  rootDir: string,
  declaredGroups: readonly PreparationDeclarationGroupSelector[],
  extracts: readonly ExtractTypeDeclarationsOperation[],
  baselines: ReadonlyMap<string, Uint8Array>,
  failures: string[],
): void {
  const operationOwners = new Map<string, number>();
  const manifestOwners = new Map<string, number>();
  for (const group of declaredGroups) manifestOwners.set(group.groupId, (manifestOwners.get(group.groupId) ?? 0) + 1);
  for (const operation of extracts) {
    for (const group of operation.declarations) {
      operationOwners.set(group.groupId, (operationOwners.get(group.groupId) ?? 0) + 1);
      const baseline = baselines.get(group.sourcePath);
      verifyTargetOwnership(rootDir, operation, group, baseline, failures);
      for (const selector of group.declarations) {
        if (containsBaselineDeclaration(operation.donorContents, baseline, selector)) {
          failures.push(`donor retains selected declaration bytes: ${selector.sourcePath}:${selector.name}`);
        }
      }
    }
  }
  for (const operation of extracts) verifyFullSpanRemoval(operation, baselines.get(operation.donor.path), failures);
  for (const operation of extracts) verifyTargetDeclarationCoverage(rootDir, operation, failures);
  for (const group of declaredGroups) {
    if (manifestOwners.get(group.groupId) !== 1) failures.push(`manifest declares group more than once: ${group.groupId}`);
    if (operationOwners.get(group.groupId) !== 1) failures.push(`group does not have singular extraction ownership: ${group.groupId}`);
  }
  for (const [groupId, count] of operationOwners) {
    if (count !== 1) failures.push(`group is extracted more than once: ${groupId}`);
    if (!manifestOwners.has(groupId)) failures.push(`operation owns undeclared group: ${groupId}`);
  }
}

function verifyTypeOnlyOperations(rootDir: string, extracts: readonly ExtractTypeDeclarationsOperation[], failures: string[]): void {
  for (const operation of extracts) {
    const landed = readIfExists(rootDir, operation.target.path);
    const source = ts.createSourceFile(operation.target.path, landed ?? operation.targetContents, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!isTypeOnlyStatement(statement)) {
        failures.push(`type-only preparation emits a runtime statement: ${operation.target.path}:${ts.SyntaxKind[statement.kind]}`);
      }
    }
  }
}

function verifyCompatibility(
  rootDir: string,
  config: MonocarveConfig,
  intents: readonly CompatibilityReexportIntent[],
  extracts: readonly ExtractTypeDeclarationsOperation[],
  failures: string[],
  typeFailures: string[],
): void {
  const claims = new Set<string>();
  for (const intent of intents) {
    const text = readIfExists(rootDir, intent.fromPath);
    if (text === null) {
      failures.push(`compatibility source does not exist: ${intent.fromPath}`);
      continue;
    }
    const source = ts.createSourceFile(intent.fromPath, text, ts.ScriptTarget.Latest, true);
    const extraction = extracts.find((operation) => operation.donor.path === intent.fromPath && operation.target.path === intent.toPath);
    if (!extraction) {
      failures.push(`compatibility path pair has no extraction: ${intent.fromPath} -> ${intent.toPath}`);
    } else if (intent.moduleSpecifier !== extraction.moduleSpecifier) {
      failures.push(`compatibility specifier differs from extraction replay: ${intent.fromPath}`);
    } else {
      verifyCompatibilityClaims(intent, extraction, failures);
      verifyCompatibilityResolution(rootDir, config, intent, typeFailures);
    }
    verifyRenderedCompatibilitySurface(source, intent, failures, typeFailures);
    for (const exported of intent.exports) {
      const claim = `${intent.fromPath}:${exported.name}`;
      if (claims.has(claim)) failures.push(`compatibility export is claimed more than once: ${claim}`);
      claims.add(claim);
      const declaration = findTypeReexport(source, intent.moduleSpecifier, exported.name);
      if (!declaration) failures.push(`compatibility type export is missing: ${claim}`);
      if (hasValueReexport(source, intent.moduleSpecifier, exported.name)) {
        typeFailures.push(`compatibility export is value-bearing: ${claim}`);
      }
    }
  }
}

function verifyCompatibilityClaims(intent: CompatibilityReexportIntent, extraction: ExtractTypeDeclarationsOperation, failures: string[]): void {
  const expected = new Set(
    extraction.declarations.filter((group) => group.declarations.some((selector) => selector.originallyExported)).map((group) => group.name),
  );
  const actual = new Set(intent.exports.map((item) => item.name));
  for (const name of actual) if (!expected.has(name)) failures.push(`compatibility surface exports a private declaration: ${intent.fromPath}:${name}`);
  for (const name of expected) if (!actual.has(name)) failures.push(`compatibility surface omits a public declaration: ${intent.fromPath}:${name}`);
}

function readIfExists(rootDir: string, path: string): string | null {
  const absolute = workspacePath(rootDir, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function findTypeReexport(source: ts.SourceFile, moduleSpecifier: string, name: string): boolean {
  return source.statements.some(
    (statement) =>
      isMatchingReexport(statement, moduleSpecifier) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((item) => (statement.isTypeOnly || item.isTypeOnly) && item.name.text === name),
  );
}

function hasValueReexport(source: ts.SourceFile, moduleSpecifier: string, name: string): boolean {
  return source.statements.some(
    (statement) =>
      isMatchingReexport(statement, moduleSpecifier) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((item) => !statement.isTypeOnly && !item.isTypeOnly && item.name.text === name),
  );
}

function isMatchingReexport(statement: ts.Statement, moduleSpecifier: string): statement is ts.ExportDeclaration {
  if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
  return statement.moduleSpecifier.text === moduleSpecifier;
}

function isTypeKind(kind: PreparationDeclarationSelector["kind"]): boolean {
  return kind === "interface" || kind === "type-alias";
}

function isTypeOnlyStatement(statement: ts.Statement): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) return true;
  if (ts.isImportDeclaration(statement)) return importIsTypeOnly(statement);
  if (ts.isExportDeclaration(statement)) return exportIsTypeOnly(statement);
  return false;
}

function importIsTypeOnly(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  return (
    clause.name === undefined &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.every((item) => item.isTypeOnly)
  );
}

function exportIsTypeOnly(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return true;
  return statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.every((item) => item.isTypeOnly);
}

function verifyTargetOwnership(
  rootDir: string,
  operation: ExtractTypeDeclarationsOperation,
  group: PreparationDeclarationGroupSelector,
  baseline: Uint8Array | undefined,
  failures: string[],
): void {
  if (baseline === undefined) {
    failures.push(`target ownership has no baseline donor: ${group.sourcePath}:${group.name}`);
    return;
  }
  const targetText = readIfExists(rootDir, operation.target.path) ?? operation.targetContents;
  const target = ts.createSourceFile(operation.target.path, targetText, ts.ScriptTarget.Latest, true);
  for (const selector of group.declarations) {
    const proofs = operation.targetDeclarationProofs.filter((proof) => proof.selectorId === selector.selectorId);
    if (proofs.length !== 1) {
      failures.push(`target does not have one declaration proof: ${selector.sourcePath}:${selector.name}`);
      continue;
    }
    const proof = proofs[0]!;
    const statement = target.statements.find((item) => item.getStart(target) === proof.targetStart && item.end === proof.targetEnd);
    const fullMatches =
      statement !== undefined &&
      statement.getFullStart() === proof.targetExtractionStart &&
      statement.end === proof.targetExtractionEnd &&
      hashText(targetText.slice(proof.targetExtractionStart, proof.targetExtractionEnd)) === proof.targetExtractionHash;
    if (
      !statement ||
      !matchesTargetSelector(statement, selector) ||
      hashText(targetText.slice(proof.targetStart, proof.targetEnd)) !== proof.targetHash ||
      !fullMatches
    ) {
      failures.push(`target does not own selected declaration exactly once: ${selector.sourcePath}:${selector.name}`);
      continue;
    }
    const exported = statementHasExport(statement);
    if (exported !== (selector.originallyExported || proof.synthesizedExport) || (proof.synthesizedExport && selector.originallyExported)) {
      failures.push(`target declaration export proof differs: ${selector.sourcePath}:${selector.name}`);
    }
  }
}

function verifyFullSpanRemoval(operation: ExtractTypeDeclarationsOperation, baseline: Uint8Array | undefined, failures: string[]): void {
  if (baseline === undefined) return;
  const source = new TextDecoder().decode(baseline);
  const selectors = operation.declarations
    .flatMap((group) => group.declarations)
    .toSorted((left, right) => left.extractionStart - right.extractionStart || left.extractionEnd - right.extractionEnd);
  let cursor = 0;
  let retained = "";
  for (const selector of selectors) {
    if (selector.extractionStart < cursor) {
      failures.push(`selected extraction regions overlap: ${selector.sourcePath}:${selector.name}`);
      continue;
    }
    retained += source.slice(cursor, selector.extractionStart);
    cursor = selector.extractionEnd;
  }
  retained += source.slice(cursor);
  if (!operation.donorContents.startsWith(retained)) {
    failures.push(`donor does not preserve the baseline outside selected extraction regions: ${operation.donor.path}`);
  }
}

function matchesTargetSelector(statement: ts.Statement, selector: PreparationDeclarationSelector): boolean {
  return (
    (selector.kind === "interface" && ts.isInterfaceDeclaration(statement) && statement.name.text === selector.name) ||
    (selector.kind === "type-alias" && ts.isTypeAliasDeclaration(statement) && statement.name.text === selector.name)
  );
}

function statementHasExport(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
function containsBaselineDeclaration(text: string, baseline: Uint8Array | undefined, selector: PreparationDeclarationSelector): boolean {
  if (baseline === undefined) return false;
  const source = new TextDecoder().decode(baseline);
  return text.includes(source.slice(selector.span.start, selector.span.end));
}
