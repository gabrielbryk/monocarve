/** Independent, post-apply proofs for a type-only preparation manifest. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { MonocarveConfig } from "../config.ts";
import { fileState } from "../util/files.ts";
import { showBaselineBytes } from "../util/git.ts";
import { hashBytes, hashText, MISSING, type FileState } from "../util/hash.ts";
import { normalizePath, workspacePath } from "../util/paths.ts";
// The boundary-specific proofs (retainedRootClearance / adapterSurfaceParity)
// live in their own module purely to keep this file under the line-count gate.
import { computeBoundaryAuditProofs } from "./audit-boundary.ts";
import { verifyGeneratedSourceOperations } from "./audit-generated-source.ts";
import { verifyTargetImportProofs } from "./audit-imports.ts";
import { verifyPreparationResultModes } from "./audit-modes.ts";
import { verifyOwnership } from "./audit-ownership.ts";
import { verifyRenderedReplay } from "./audit-replay.ts";
// The changed-path scope proof lives in its own module for the same reason.
import { verifyChangedScope } from "./audit-scope.ts";
import { verifySelectors } from "./audit-selectors.ts";
import { verifyCompatibilityResolution, verifyRenderedCompatibilitySurface } from "./audit-surface.ts";
import type { PreparationAuditOptions, PreparationAuditReport } from "./audit-types.ts";
import { preparationProof } from "./audit-types.ts";
import type { CompatibilityReexportIntent, ExtractTypeDeclarationsOperation, PreparationReplayOperation } from "./manifest-types.ts";
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
  const failures = emptyFailureLists();

  const baselineByPath = new Map<string, Uint8Array>();
  for (const operation of extracts) {
    verifyMutationBytes(rootDir, manifest.baseline.commit, operation, baselineByPath, failures.byteReplay);
  }
  const modeChecks = verifyPreparationResultModes(rootDir, manifest.operations, failures.fileModes);
  for (const operation of manifest.operations)
    if (operation.kind === "write-file") verifyWriteBytes(rootDir, manifest.baseline.commit, operation, failures.byteReplay);
  verifyGeneratedSourceOperations(rootDir, manifest.baseline.commit, manifest.operations, failures.byteReplay);
  for (const operation of extracts) verifyRenderedReplay(operation, baselineByPath.get(operation.donor.path), failures.renderedReplay);

  const selectors = extracts.flatMap((operation) => operation.declarations.flatMap((group) => group.declarations));
  verifySelectors(selectors, baselineByPath, failures.selectorIntegrity);
  verifyOwnership(rootDir, manifest.declarations, extracts, baselineByPath, failures.declarationOwnership);
  verifyTypeOnlyOperations(rootDir, extracts, failures.typeValueClaims);
  verifyCompatibility(rootDir, options.config, manifest.compatibilityReexports, extracts, failures.compatibilitySurface, failures.typeValueClaims);
  verifyTargetImportProofs(rootDir, options.config, extracts, baselineByPath, failures.targetImportResolution);
  const provenancePath = options.approvedManifestPath === undefined ? undefined : normalizePath(options.approvedManifestPath);
  verifyChangedScope(rootDir, manifest.baseline.commit, manifest.changedFiles, provenancePath, failures.changedPathScope, [
    ...(manifest.generatedArtifacts ?? []).filter((item) => item.exemptReason !== undefined).map((item) => item.path),
    ...(manifest.postJournalPreparers ?? []).flatMap((item) => item.outputs),
  ]);
  verifyGraphEvidence(options, failures.graphDigest);
  const boundaryProofs = computeBoundaryAuditProofs(rootDir, manifest.operations);
  verifyGeneratedArtifacts(options, failures.generatedArtifactFreshness);
  return auditReport(options, failures, { extracts: extracts.length, selectors: selectors.length, modeChecks }, boundaryProofs);
}

type AuditFailureLists = Record<
  | "byteReplay"
  | "fileModes"
  | "renderedReplay"
  | "selectorIntegrity"
  | "declarationOwnership"
  | "compatibilitySurface"
  | "targetImportResolution"
  | "changedPathScope"
  | "typeValueClaims"
  | "graphDigest"
  | "generatedArtifactFreshness",
  string[]
>;

function emptyFailureLists(): AuditFailureLists {
  return {
    byteReplay: [],
    fileModes: [],
    renderedReplay: [],
    selectorIntegrity: [],
    declarationOwnership: [],
    compatibilitySurface: [],
    targetImportResolution: [],
    changedPathScope: [],
    typeValueClaims: [],
    graphDigest: [],
    generatedArtifactFreshness: [],
  };
}

function verifyGraphEvidence(options: PreparationAuditOptions, failures: string[]): void {
  if (options.freshGraph.commit !== options.manifest.baseline.commit) {
    failures.push("fresh graph commit does not match the preparation baseline");
  }
  if (options.freshGraph.digest !== options.manifest.graphDigest) {
    failures.push("manifest graph digest does not match the fresh graph evidence");
  }
}

function verifyGeneratedArtifacts(options: PreparationAuditOptions, failures: string[]): void {
  for (const artifact of options.manifest.generatedArtifacts ?? []) {
    const current = fileState(workspacePath(options.rootDir, artifact.path));
    if (current === MISSING) failures.push(`declared generated artifact is missing: ${artifact.path}`);
    const observed = options.regeneratedArtifacts?.[artifact.path];
    if (options.regeneratedArtifacts !== undefined && observed === undefined) failures.push(`generator replay supplied no freshness hash for ${artifact.path}`);
    else if (observed !== undefined && current !== observed) failures.push(`generated artifact changed after regeneration: ${artifact.path}`);
  }
}

function auditReport(
  options: PreparationAuditOptions,
  lists: AuditFailureLists,
  counts: { readonly extracts: number; readonly selectors: number; readonly modeChecks: number },
  { retainedRootClearance, adapterSurfaceParity }: ReturnType<typeof computeBoundaryAuditProofs>,
): PreparationAuditReport {
  const { manifest } = options;
  const writes = manifest.operations.filter((item) => item.kind === "write-file").length;
  const compatibility = manifest.compatibilityReexports.length;
  const targetImports = manifest.operations.filter(isExtract).reduce((total, item) => total + item.targetImportProofs.length, 0);
  const proofs = {
    byteReplay: preparationProof(lists.byteReplay, counts.extracts * 5 + writes * 3),
    fileModes: preparationProof(lists.fileModes, counts.modeChecks),
    renderedReplay: preparationProof(lists.renderedReplay, counts.extracts),
    selectorIntegrity: preparationProof(lists.selectorIntegrity, counts.selectors),
    declarationOwnership: preparationProof(lists.declarationOwnership, manifest.declarations.length),
    compatibilitySurface: preparationProof(lists.compatibilitySurface, compatibility),
    targetImportResolution: preparationProof(lists.targetImportResolution, targetImports),
    changedPathScope: preparationProof(lists.changedPathScope, manifest.changedFiles.length),
    typeValueClaims: preparationProof(lists.typeValueClaims, counts.extracts + compatibility),
    graphDigest: preparationProof(lists.graphDigest, 2),
    generatedArtifactFreshness: preparationProof(lists.generatedArtifactFreshness, (manifest.generatedArtifacts ?? []).length),
    retainedRootClearance,
    adapterSurfaceParity,
  };
  const failures = Object.values(proofs).flatMap((proof) => proof.failures);
  return {
    planId: manifest.planId,
    baselineCommit: manifest.baseline.commit,
    auditedRoot: resolve(options.rootDir),
    passed: failures.length === 0,
    ...proofs,
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

function verifyTypeOnlyOperations(rootDir: string, extracts: readonly ExtractTypeDeclarationsOperation[], failures: string[]): void {
  for (const operation of extracts) {
    const landed = readIfExists(rootDir, operation.target.path);
    const source = ts.createSourceFile(operation.target.path, landed ?? operation.targetContents, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements.filter((item) => !isTypeOnlyStatement(item)))
      failures.push(`type-only preparation emits a runtime statement: ${operation.target.path}:${ts.SyntaxKind[statement.kind]}`);
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
  for (const intent of intents) verifyCompatibilityIntent(rootDir, config, intent, extracts, claims, failures, typeFailures);
}

function verifyCompatibilityIntent(
  rootDir: string,
  config: MonocarveConfig,
  intent: CompatibilityReexportIntent,
  extracts: readonly ExtractTypeDeclarationsOperation[],
  claims: Set<string>,
  failures: string[],
  typeFailures: string[],
): void {
  const text = readIfExists(rootDir, intent.fromPath);
  if (text === null) {
    failures.push(`compatibility source does not exist: ${intent.fromPath}`);
    return;
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
    if (!findTypeReexport(source, intent.moduleSpecifier, exported.name)) failures.push(`compatibility type export is missing: ${claim}`);
    if (hasValueReexport(source, intent.moduleSpecifier, exported.name)) typeFailures.push(`compatibility export is value-bearing: ${claim}`);
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
