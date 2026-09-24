/** Validation of type-only extraction operations and their rendered target declaration proofs. */
import ts from "typescript";

import { hashJson, hashText, isSha256 } from "../util/hash.ts";
import { groupKey, isModuleSpecifier, reportOverlaps, validateMutation, validateSorted, type AddIssue } from "./manifest-checks.ts";
import { validateReplayRecipe } from "./manifest-recipe.ts";
import type {
  ExtractTypeDeclarationsOperation,
  PreparationDeclarationGroupSelector,
  PreparationDeclarationSelector,
  PreparationTargetDeclarationProof,
} from "./manifest-types.ts";

export function validateExtractOperation(
  operation: ExtractTypeDeclarationsOperation,
  groupById: ReadonlyMap<string, PreparationDeclarationGroupSelector>,
  includedGroups: Set<string>,
  add: AddIssue,
): void {
  if (operation.donor.path === operation.target.path) add("extract-paths", "donor and target paths must differ", operation.donor.path);
  if (!isSha256(operation.donor.preconditionHash) || operation.target.preconditionHash !== "missing")
    add("extract-precondition", "an extraction donor must have a SHA-256 precondition and its new target must be missing", operation.donor.path);
  if (operation.donor.preconditionMode !== operation.donor.resultMode)
    add("extract-mode", "donor rewrite must preserve its baseline mode", operation.donor.path);
  if (!isModuleSpecifier(operation.moduleSpecifier))
    add("extract-specifier", "extraction moduleSpecifier must be a non-empty, non-traversing module specifier", operation.donor.path);
  validateMutation(operation.donor, operation.donorContents, "extract-donor", add);
  validateMutation(operation.target, operation.targetContents, "extract-target", add);
  validateReplayRecipe(operation, add);
  validateTargetDeclarationProofs(operation, add);
  if (operation.declarations.length === 0) add("extract-declarations", "an extraction must contain at least one complete group", operation.donor.path);
  validateSorted(operation.declarations, groupKey, "extract-declaration-order", "extracted declaration groups must be deterministically ordered", add);
  for (const group of operation.declarations) validateExtractedGroup(operation, group, groupById, includedGroups, add);
}

function validateExtractedGroup(
  operation: ExtractTypeDeclarationsOperation,
  group: PreparationDeclarationGroupSelector,
  groupById: ReadonlyMap<string, PreparationDeclarationGroupSelector>,
  includedGroups: Set<string>,
  add: AddIssue,
): void {
  const expected = groupById.get(group.groupId);
  if (!expected || hashJson(expected) !== hashJson(group))
    add("extract-declarations", `extraction group ${group.groupId} does not match a declared selector`, operation.donor.path);
  if (includedGroups.has(group.groupId)) add("extract-declarations", `declaration group ${group.groupId} is extracted more than once`, operation.donor.path);
  includedGroups.add(group.groupId);
  for (const declaration of group.declarations) {
    if (declaration.sourcePath !== operation.donor.path || declaration.sourceHash !== operation.donor.preconditionHash)
      add("extract-selector", "every selector must bind to the donor path and precondition hash", operation.donor.path);
  }
}

function validateTargetDeclarationProofs(operation: ExtractTypeDeclarationsOperation, add: AddIssue): void {
  const selectors = operation.declarations.flatMap((group) => group.declarations);
  const selectorsById = new Map(selectors.map((selector) => [selector.selectorId, selector]));
  validateSorted(
    operation.targetDeclarationProofs,
    (proof) => proof.selectorId,
    "target-declaration-order",
    "target declaration proofs must be deterministically ordered and unique",
    add,
  );
  if (operation.targetDeclarationProofs.length !== selectors.length)
    add("target-declaration-proof", "target declaration proofs must cover every extracted selector exactly once", operation.target.path);
  const proofs = new Set<string>();
  const target = ts.createSourceFile(operation.target.path, operation.targetContents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const proof of operation.targetDeclarationProofs) {
    if (proofs.has(proof.selectorId)) add("target-declaration-proof", `duplicate target declaration proof for ${proof.selectorId}`, operation.target.path);
    proofs.add(proof.selectorId);
    const selector = selectorsById.get(proof.selectorId);
    if (!selector) add("target-declaration-proof", `target declaration proof has no extracted selector: ${proof.selectorId}`, operation.target.path);
    else validateTargetDeclarationProof(operation, target, proof, selector, add);
  }
  for (const selector of selectors)
    if (!proofs.has(selector.selectorId)) add("target-declaration-proof", `missing target declaration proof for ${selector.name}`, operation.target.path);
  reportOverlaps(
    operation.targetDeclarationProofs,
    (proof) => ({ start: proof.targetExtractionStart, end: proof.targetExtractionEnd }),
    (proof) => proof.selectorId,
    () => add("target-declaration-proof", "target declaration extraction regions must not overlap", operation.target.path),
  );
}

/** One proof, checked in order; the first failing check is the only one reported. */
function validateTargetDeclarationProof(
  operation: ExtractTypeDeclarationsOperation,
  target: ts.SourceFile,
  proof: PreparationTargetDeclarationProof,
  selector: PreparationDeclarationSelector,
  add: AddIssue,
): void {
  const fail = (message: string): void => add("target-declaration-proof", message, operation.target.path);
  const contents = operation.targetContents;
  if (!hasValidProofShape(proof, contents.length)) return fail(`target declaration proof for ${selector.name} has an invalid span or hash`);
  if (hashText(contents.slice(proof.targetStart, proof.targetEnd)) !== proof.targetHash)
    return fail(`target declaration hash for ${selector.name} does not match target replay bytes`);
  if (hashText(contents.slice(proof.targetExtractionStart, proof.targetExtractionEnd)) !== proof.targetExtractionHash)
    return fail(`target extraction hash for ${selector.name} does not match target replay bytes`);
  const statement = target.statements.find((item) => item.getStart(target) === proof.targetStart && item.end === proof.targetEnd);
  if (!statement || !statementMatchesProof(statement, proof, selector))
    return fail(`target declaration proof for ${selector.name} does not name its rendered type declaration`);
  if (!exportMatchesProof(hasExportModifier(statement), proof, selector))
    fail(`target export proof for ${selector.name} does not match the rendered declaration`);
}

function hasValidProofShape(proof: PreparationTargetDeclarationProof, length: number): boolean {
  return (
    isSha256(proof.targetHash) &&
    isSha256(proof.targetExtractionHash) &&
    Number.isInteger(proof.targetStart) &&
    Number.isInteger(proof.targetEnd) &&
    Number.isInteger(proof.targetExtractionStart) &&
    Number.isInteger(proof.targetExtractionEnd) &&
    proof.targetStart >= 0 &&
    proof.targetEnd > proof.targetStart &&
    proof.targetEnd <= length &&
    proof.targetExtractionStart >= 0 &&
    proof.targetExtractionEnd >= proof.targetExtractionStart &&
    proof.targetExtractionEnd <= length &&
    proof.targetExtractionStart <= proof.targetStart &&
    proof.targetExtractionEnd >= proof.targetEnd
  );
}

function statementMatchesProof(statement: ts.Statement, proof: PreparationTargetDeclarationProof, selector: PreparationDeclarationSelector): boolean {
  return (
    statement.getFullStart() === proof.targetExtractionStart &&
    statement.end === proof.targetExtractionEnd &&
    matchesTargetSelector(statement, selector.name, selector.kind)
  );
}

function exportMatchesProof(exported: boolean, proof: PreparationTargetDeclarationProof, selector: PreparationDeclarationSelector): boolean {
  return (
    typeof proof.synthesizedExport === "boolean" &&
    exported === (selector.originallyExported || proof.synthesizedExport) &&
    !(proof.synthesizedExport && selector.originallyExported)
  );
}

function matchesTargetSelector(statement: ts.Statement, name: string, kind: PreparationDeclarationSelector["kind"]): boolean {
  return (
    (kind === "interface" && ts.isInterfaceDeclaration(statement) && statement.name.text === name) ||
    (kind === "type-alias" && ts.isTypeAliasDeclaration(statement) && statement.name.text === name)
  );
}

function hasExportModifier(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
