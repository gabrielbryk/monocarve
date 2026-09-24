/** Declaration-ownership proof: each selected group is extracted exactly once, owned by its target, and gone from its donor. */
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

import { hashText } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { verifyTargetDeclarationCoverage } from "./audit-surface.ts";
import type { ExtractTypeDeclarationsOperation, PreparationDeclarationGroupSelector, PreparationDeclarationSelector } from "./manifest-types.ts";

export function verifyOwnership(
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
    for (const group of operation.declarations) verifyGroupOwnership(rootDir, operation, group, baselines, operationOwners, failures);
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

function verifyGroupOwnership(
  rootDir: string,
  operation: ExtractTypeDeclarationsOperation,
  group: PreparationDeclarationGroupSelector,
  baselines: ReadonlyMap<string, Uint8Array>,
  operationOwners: Map<string, number>,
  failures: string[],
): void {
  operationOwners.set(group.groupId, (operationOwners.get(group.groupId) ?? 0) + 1);
  const baseline = baselines.get(group.sourcePath);
  verifyTargetOwnership(rootDir, operation, group, baseline, failures);
  for (const selector of group.declarations) {
    if (containsBaselineDeclaration(operation.donorContents, baseline, selector)) {
      failures.push(`donor retains selected declaration bytes: ${selector.sourcePath}:${selector.name}`);
    }
  }
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
  for (const selector of group.declarations) verifySelectorTargetOwnership(operation, target, targetText, selector, failures);
}

function verifySelectorTargetOwnership(
  operation: ExtractTypeDeclarationsOperation,
  target: ts.SourceFile,
  targetText: string,
  selector: PreparationDeclarationSelector,
  failures: string[],
): void {
  const proofs = operation.targetDeclarationProofs.filter((proof) => proof.selectorId === selector.selectorId);
  const proof = proofs[0];
  if (proofs.length !== 1 || proof === undefined) {
    failures.push(`target does not have one declaration proof: ${selector.sourcePath}:${selector.name}`);
    return;
  }
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
    return;
  }
  const exported = statementHasExport(statement);
  if (exported !== (selector.originallyExported || proof.synthesizedExport) || (proof.synthesizedExport && selector.originallyExported)) {
    failures.push(`target declaration export proof differs: ${selector.sourcePath}:${selector.name}`);
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

function readIfExists(rootDir: string, path: string): string | null {
  const absolute = workspacePath(rootDir, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}
