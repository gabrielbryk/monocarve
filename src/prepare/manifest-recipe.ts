import { byCodeUnit } from "../util/hash.ts";
import type {
  ExtractTypeDeclarationsOperation,
  PreparationCheckerProvenTypeImport,
  PreparationTargetImportProof,
} from "./manifest-types.ts";

export type AddManifestIssue = (rule: string, message: string, path?: string) => void;

/** Validates every field required to replay imports and compatibility exports verbatim. */
export function validateReplayRecipe(operation: ExtractTypeDeclarationsOperation, add: AddManifestIssue): void {
  const targetImports = validateImports(operation.targetImports, operation.donor.path, operation.donor.preconditionHash, "target", add);
  validateImports(operation.donorImports, operation.donor.path, operation.donor.preconditionHash, "donor", add);
  validateProvenance(operation.targetImportProofs, targetImports, operation.donor.path, operation.donor.preconditionHash, add);
  validateInlineImportProofs(operation, add);
  const expectedExports = operation.declarations
    .filter((group) => group.declarations.some((selector) => selector.originallyExported))
    .map((group) => group.name)
    .sort(byCodeUnit);
  validateSortedStrings(operation.reExportNames, "replay-reexports", "reExportNames", add);
  if (operation.reExportNames.length !== expectedExports.length || operation.reExportNames.some((name, index) => name !== expectedExports[index])) {
    add("replay-reexports", "reExportNames must exactly equal the originally public extracted groups", operation.donor.path);
  }
}

function validateInlineImportProofs(operation: ExtractTypeDeclarationsOperation, add: AddManifestIssue): void {
  const proofs = operation.inlineImportTypeProofs ?? [];
  let previousEnd = -1;
  for (const proof of proofs) {
    if (!isRelative(proof.originalSpecifier) || !isRelative(proof.targetSpecifier) ||
      !isWorkspacePath(proof.resolvedSourcePath) || proof.proofBaselineHash !== operation.donor.preconditionHash ||
      !Number.isInteger(proof.start) || !Number.isInteger(proof.end) || proof.start < previousEnd || proof.end <= proof.start ||
      !/^[0-9a-f]{64}$/.test(proof.sourceHash)) {
      add("inline-import-type-proof", "inline import type rewrite proof is incomplete or not deterministically ordered", operation.donor.path);
    }
    previousEnd = proof.end;
  }
}

function validateImports(
  imports: readonly PreparationCheckerProvenTypeImport[],
  path: string,
  baselineHash: string,
  location: string,
  add: AddManifestIssue,
): ReadonlyMap<string, PreparationCheckerProvenTypeImport> {
  validateSorted(imports, checkerImportKey, "replay-import-order", `${location} imports must be deterministically ordered and unique`, add);
  const bindings = new Map<string, PreparationCheckerProvenTypeImport>();
  for (const item of imports) {
    if (!isModuleSpecifier(item.moduleSpecifier) || !isIdentifier(item.localName) || item.requiredAs !== "type" || typeof item.originallyTypeOnly !== "boolean" || item.proofBaselineHash !== baselineHash || !validImportShape(item)) {
      add("replay-import", `${location} import is not a complete checker-proven type binding`, path);
    }
    const binding = `${item.moduleSpecifier}\u0000${item.localName}`;
    if (bindings.has(binding)) add("replay-import", `${location} imports duplicate local binding ${item.localName}`, path);
    bindings.set(binding, item);
  }
  return bindings;
}

function validateProvenance(
  proofs: readonly PreparationTargetImportProof[],
  imports: ReadonlyMap<string, PreparationCheckerProvenTypeImport>,
  path: string,
  baselineHash: string,
  add: AddManifestIssue,
): void {
  validateSorted(proofs, targetImportProofKey, "target-import-order", "target import proofs must be deterministically ordered and unique", add);
  const bindings = new Set<string>();
  const proofCounts = new Map<string, number>();
  for (const proof of proofs) {
    const imported = imports.get(`${proof.targetSpecifier}\u0000${proof.localName}`);
    if (!isRelative(proof.originalSpecifier) || !isRelative(proof.targetSpecifier) || !isWorkspacePath(proof.resolvedSourcePath) || proof.proofBaselineHash !== baselineHash || !imported || !matchesTargetBinding(proof, imported)) {
      add("target-import-proof", "target import rewrite proof does not match a checker-proven rendered binding", path);
    }
    const binding = `${proof.targetSpecifier}\u0000${proof.localName}`;
    if (bindings.has(binding)) add("target-import-proof", `duplicate rendered import binding ${proof.localName}`, path);
    bindings.add(binding);
    proofCounts.set(binding, (proofCounts.get(binding) ?? 0) + 1);
  }
  for (const imported of imports.values()) {
    if (!isRelative(imported.moduleSpecifier)) continue;
    const binding = `${imported.moduleSpecifier}\u0000${imported.localName}`;
    if (proofCounts.get(binding) !== 1) add("target-import-proof", `relative target import ${imported.localName} must have exactly one resolution provenance proof`, path);
  }
}

function matchesTargetBinding(proof: PreparationTargetImportProof, imported: PreparationCheckerProvenTypeImport): boolean {
  return imported.moduleSpecifier === proof.targetSpecifier
    && imported.localName === proof.localName
    && imported.importedName === proof.importedName
    && imported.kind === proof.kind
    && imported.originallyTypeOnly === proof.originallyTypeOnly
    && imported.requiredAs === proof.requiredAs
    && imported.proofBaselineHash === proof.proofBaselineHash;
}

function validImportShape(item: PreparationCheckerProvenTypeImport): boolean {
  return (item.kind === "named" && item.importedName !== "default" && isIdentifier(item.importedName))
    || (item.kind === "default" && item.importedName === "default")
    || (item.kind === "namespace" && item.importedName === "*");
}

function checkerImportKey(item: PreparationCheckerProvenTypeImport): string {
  return `${item.moduleSpecifier}\u0000${item.localName}\u0000${item.kind}\u0000${item.importedName}\u0000${item.originallyTypeOnly}\u0000${item.requiredAs}\u0000${item.proofBaselineHash}`;
}

function targetImportProofKey(proof: PreparationTargetImportProof): string {
  return `${proof.targetSpecifier}\u0000${proof.localName}\u0000${proof.kind}\u0000${proof.importedName}\u0000${proof.originalSpecifier}\u0000${proof.resolvedSourcePath}`;
}

function validateSorted<T>(items: readonly T[], key: (item: T) => string, rule: string, message: string, add: AddManifestIssue): void {
  for (let index = 1; index < items.length; index += 1) if (byCodeUnit(key(items[index - 1]!), key(items[index]!)) >= 0) add(rule, message);
}

function validateSortedStrings(items: readonly string[], rule: string, label: string, add: AddManifestIssue): void {
  for (const item of items) if (!isIdentifier(item)) add(rule, `${label} entries must be identifiers`);
  for (let index = 1; index < items.length; index += 1) if (byCodeUnit(items[index - 1]!, items[index]!) >= 0) add(rule, `${label} must be sorted and unique`);
}

function isRelative(value: string): boolean { return isModuleSpecifier(value) && value.startsWith("."); }
function isIdentifier(value: string): boolean { return typeof value === "string" && /^[$A-Z_a-z][$\w]*$/u.test(value); }
function isWorkspacePath(path: string): boolean { return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.startsWith("\\") && !path.split("/").some((part) => part === "" || part === "." || part === ".."); }
function isModuleSpecifier(specifier: string): boolean {
  if (typeof specifier !== "string" || specifier.length === 0 || /[\\\r\n\u0000]/.test(specifier) || specifier.startsWith("/")) return false;
  if (!specifier.startsWith(".")) return true;
  const segments = specifier.split("/"); let index = segments[0] === "." ? 1 : 0;
  while (segments[index] === "..") index += 1;
  return index > 0 && index < segments.length && segments.slice(index).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
