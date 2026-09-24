import { posix } from "node:path";
import ts from "typescript";

import { byCodeUnit, hashText, isSha256 } from "../util/hash.ts";
import type {
  DeleteModuleOperation,
  ExtractTypeDeclarationsOperation,
  PreparationCheckerProvenTypeImport,
  PreparationFileMutation,
  PreparationReplayOperation,
  PreparationWriteFileOperation,
  PreparationTargetImportProof,
  RewriteModuleSpecifierOperation,
} from "./manifest-types.ts";

export type AddManifestIssue = (rule: string, message: string, path?: string) => void;

/**
 * Validates a consumer rewrite's `rewrites` recipe against its own rendered
 * `contents` — the same "replay it, don't just claim it" rigour extraction
 * recipes get. Each declared `to` specifier must be a real, parsed import (or
 * re-export) binding every named symbol, and the retired `from` specifier
 * must not still be referenced.
 */
export function validateRewriteRecipe(operation: RewriteModuleSpecifierOperation, add: AddManifestIssue): void {
  if (operation.rewrites.length === 0) {
    add("rewrite-specifier", "rewrite-module-specifier must declare at least one rewrite", operation.file.path);
    return;
  }
  validateSorted(operation.rewrites, rewriteKey, "rewrite-specifier-order", "rewrites must be deterministically ordered and unique", add);
  const bindings = collectSpecifierBindings(operation.file.path, operation.contents);
  for (const rewrite of operation.rewrites) validateRewriteEntry(operation.file.path, operation.contents, rewrite, bindings, add);
}

/** Bind each promoted contract write to the exact package subpath consumers use. */
export function validatePortPackageExportRecipe(operations: readonly PreparationReplayOperation[], add: AddManifestIssue): void {
  const packageWrites = operations.filter(
    (operation): operation is PreparationWriteFileOperation => operation.kind === "write-file" && operation.purpose === "port-package-export",
  );
  const contracts = operations.filter(
    (operation): operation is PreparationWriteFileOperation => operation.kind === "write-file" && operation.purpose === "port-contract",
  );
  const rewrites = operations
    .filter((operation): operation is RewriteModuleSpecifierOperation => operation.kind === "rewrite-module-specifier")
    .flatMap((operation) => operation.rewrites);
  for (const operation of packageWrites) validatePortPackageWrite(operation, contracts, rewrites, add);
}

function validatePortPackageWrite(
  operation: PreparationWriteFileOperation,
  contracts: readonly PreparationWriteFileOperation[],
  rewrites: readonly ModuleRewrite[],
  add: AddManifestIssue,
): void {
  const manifest = parsePackageManifest(operation.contents);
  if (manifest === undefined) {
    add("port-package-export", "port package export write must contain valid JSON", operation.file.path);
    return;
  }
  const name = typeof manifest.name === "string" ? manifest.name : undefined;
  const exports = packageExports(manifest);
  const packageRoot = posix.dirname(operation.file.path);
  const matches = contracts.flatMap((contract) => {
    const target = `./${posix.relative(packageRoot, contract.file.path)}`;
    return Object.entries(exports)
      .filter(([, value]) => exportLeavesMatch(value, target))
      .map(([key]) => ({ key, contract }));
  });
  if (!name || matches.length !== 1) {
    add("port-package-export", "port package export must bind exactly one promoted contract target", operation.file.path);
    return;
  }
  const specifier = `${name}${matches[0]!.key.slice(1)}`;
  if (!rewrites.some((rewrite) => rewrite.to === specifier)) {
    add("port-package-export", `port package export ${matches[0]!.key} has no consumer rewrite to ${specifier}`, operation.file.path);
  }
}

function parsePackageManifest(contents: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(contents) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function packageExports(manifest: Record<string, unknown>): Record<string, unknown> {
  const exports = manifest.exports;
  return exports && typeof exports === "object" && !Array.isArray(exports) ? (exports as Record<string, unknown>) : {};
}

function exportLeavesMatch(value: unknown, target: string): boolean {
  if (typeof value === "string") return value === target;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const leaves = Object.values(value as Record<string, unknown>);
  return leaves.length > 0 && leaves.every((leaf) => exportLeavesMatch(leaf, target));
}

/**
 * Validates a shim deletion's precondition/result shape and its importer
 * proof. `importerProof` is only checked against this same manifest's own
 * rewrite operations here — a later, graph-aware audit stage owns proving
 * that set is exhaustive against the live repository (see manifest-types.ts).
 */
export function validateDeletionRecipe(operation: DeleteModuleOperation, operations: readonly PreparationReplayOperation[], add: AddManifestIssue): void {
  validateDeletionMutation(operation.file, add);
  validateImporterProof(operation.importerProof, operation.file.path, add);
  const rewritten = new Set(
    operations.filter((item): item is RewriteModuleSpecifierOperation => item.kind === "rewrite-module-specifier").map((item) => item.file.path),
  );
  for (const importer of operation.importerProof) {
    if (!rewritten.has(importer)) {
      add(
        "delete-module-importers",
        `importerProof names ${importer}, but no rewrite-module-specifier operation in this manifest rewrote it`,
        operation.file.path,
      );
    }
  }
}

function validateDeletionMutation(file: PreparationFileMutation, add: AddManifestIssue): void {
  if (!isSha256(file.preconditionHash)) add("delete-module-precondition", "a deleted module must have an existing, proven baseline hash", file.path);
  if (file.preconditionMode === "missing" || !isCanonicalFileMode(file.preconditionMode)) {
    add("delete-module-precondition", "a deleted module's precondition mode must be a canonical Git file mode", file.path);
  }
  // A deletion has no post-state. These are the canonical empty-text sentinel
  // values `boundary-imports.ts`'s planDeletion writes — never a real hash of
  // rendered bytes, because there are none.
  if (file.resultHash !== hashText(""))
    add("delete-module-result", "a deletion carries no post-state; resultHash must be the canonical empty-text sentinel", file.path);
  if (file.resultMode !== 0) add("delete-module-result", "a deletion carries no post-state; resultMode must be 0", file.path);
}

function validateImporterProof(paths: readonly string[], path: string, add: AddManifestIssue): void {
  for (const importer of paths) if (!isWorkspacePath(importer)) add("delete-module-importers", "importerProof entries must be workspace-relative paths", path);
  for (let index = 1; index < paths.length; index += 1) {
    if (byCodeUnit(paths[index - 1]!, paths[index]!) >= 0) add("delete-module-importers", "importerProof must be sorted and unique", path);
  }
}

function rewriteKey(rewrite: { readonly from: string; readonly to: string; readonly moduleSpecifierCall?: string }): string {
  return `${rewrite.from}\0${rewrite.to}\0${rewrite.moduleSpecifierCall ?? ""}`;
}

type ModuleRewrite = RewriteModuleSpecifierOperation["rewrites"][number];
type SpecifierBindings = ReadonlyMap<string, ReadonlySet<string>>;

function validateRewriteEntry(path: string, contents: string, rewrite: ModuleRewrite, bindings: SpecifierBindings, add: AddManifestIssue): void {
  if (!isModuleSpecifier(rewrite.from) || !isModuleSpecifier(rewrite.to) || rewrite.from === rewrite.to) {
    add("rewrite-specifier", "each rewrite must name two distinct, non-empty module specifiers", path);
  }
  if (rewrite.moduleSpecifierCall !== undefined) {
    validateCallRewrite(path, contents, rewrite, rewrite.moduleSpecifierCall, add);
    return;
  }
  if (!validateMovedSymbols(path, rewrite, bindings, add)) return;
  validateRetainedSymbols(path, rewrite, bindings, add);
}

function validateCallRewrite(path: string, contents: string, rewrite: ModuleRewrite, call: string, add: AddManifestIssue): void {
  if (rewrite.symbols.length !== 0) add("rewrite-symbols", "a module-specifier call rewrite must not claim imported symbols", path);
  const specifiers = collectModuleSpecifierCalls(path, contents).get(call);
  if (!specifiers?.has(rewrite.to)) add("rewrite-specifier", `rewritten contents do not call ${call} with replacement specifier ${rewrite.to}`, path);
  if (specifiers?.has(rewrite.from)) add("rewrite-specifier", `rewritten contents still call ${call} with retired specifier ${rewrite.from}`, path);
}

/** Returns false when the replacement specifier is not imported at all, which makes the retained checks moot. */
function validateMovedSymbols(path: string, rewrite: ModuleRewrite, bindings: SpecifierBindings, add: AddManifestIssue): boolean {
  if (rewrite.symbols.length === 0) add("rewrite-symbols", "each rewrite must name at least one moved symbol", path);
  for (const symbol of rewrite.symbols) if (!isIdentifier(symbol)) add("rewrite-symbols", `rewrite symbol ${symbol} is not a valid identifier`, path);
  for (let index = 1; index < rewrite.symbols.length; index += 1) {
    if (byCodeUnit(rewrite.symbols[index - 1]!, rewrite.symbols[index]!) >= 0) add("rewrite-symbols", "rewrite symbols must be sorted and unique", path);
  }
  const bound = bindings.get(rewrite.to);
  if (!bound) {
    add("rewrite-specifier", `rewritten contents do not import the replacement specifier ${rewrite.to}`, path);
    return false;
  }
  for (const symbol of rewrite.symbols) if (!bound.has(symbol)) add("rewrite-symbols", `rewritten contents do not bind ${symbol} from ${rewrite.to}`, path);
  if ([...bound].some((symbol) => !rewrite.symbols.includes(symbol))) {
    add("rewrite-symbols", `rewritten contents bind undeclared symbols from ${rewrite.to}`, path);
  }
  return true;
}

function validateRetainedSymbols(path: string, rewrite: ModuleRewrite, bindings: SpecifierBindings, add: AddManifestIssue): void {
  const retainedSymbols = rewrite.retainedSymbols ?? [];
  validateSortedStrings(retainedSymbols, "rewrite-symbols", "retained rewrite symbols", add);
  const retained = bindings.get(rewrite.from);
  if (retainedSymbols.length === 0 && retained) add("rewrite-specifier", `rewritten contents still reference the retired specifier ${rewrite.from}`, path);
  if (retainedSymbols.length > 0 && !retained) add("rewrite-specifier", `rewritten contents do not retain the original specifier ${rewrite.from}`, path);
  for (const symbol of retainedSymbols)
    if (!retained?.has(symbol)) add("rewrite-symbols", `rewritten contents do not retain ${symbol} from ${rewrite.from}`, path);
  if (retained && [...retained].some((symbol) => !retainedSymbols.includes(symbol))) {
    add("rewrite-symbols", `rewritten contents retain undeclared symbols from ${rewrite.from}`, path);
  }
}

function collectModuleSpecifierCalls(path: string, text: string): ReadonlyMap<string, ReadonlySet<string>> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const calls = new Map<string, Set<string>>();
  const qualifiedName = (node: ts.Expression): string | undefined => {
    if (ts.isIdentifier(node)) return node.text;
    if (!ts.isPropertyAccessExpression(node)) return undefined;
    const parent = qualifiedName(node.expression);
    return parent === undefined ? undefined : `${parent}.${node.name.text}`;
  };
  const record = (call: string | undefined, specifier: string): void => {
    if (call === undefined) return;
    const specifiers = calls.get(call) ?? new Set<string>();
    specifiers.add(specifier);
    calls.set(call, specifiers);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) {
      record(qualifiedName(node.expression), node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/**
 * Every specifier `operation.contents` actually references, mapped to the
 * exact names bound through it. Deliberately reads only the rendered text —
 * never the filesystem — so this stays the same pure, replayable proof the
 * rest of manifest validation is.
 */
function collectSpecifierBindings(path: string, text: string): ReadonlyMap<string, ReadonlySet<string>> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bindings = new Map<string, Set<string>>();
  const touch = (specifier: string): Set<string> => {
    const existing = bindings.get(specifier);
    if (existing) return existing;
    const created = new Set<string>();
    bindings.set(specifier, created);
    return created;
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      collectImportBindings(statement, touch(statement.moduleSpecifier.text));
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      collectExportBindings(statement, touch(statement.moduleSpecifier.text));
    }
  }
  return bindings;
}

function collectImportBindings(statement: ts.ImportDeclaration, names: Set<string>): void {
  const clause = statement.importClause;
  if (clause?.name) names.add("default");
  const named = clause?.namedBindings;
  if (named && ts.isNamespaceImport(named)) names.add("*");
  if (named && ts.isNamedImports(named)) for (const element of named.elements) names.add((element.propertyName ?? element.name).text);
}

function collectExportBindings(statement: ts.ExportDeclaration, names: Set<string>): void {
  if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    for (const element of statement.exportClause.elements) names.add((element.propertyName ?? element.name).text);
  }
}

function isCanonicalFileMode(value: number): boolean {
  return value === 0o644 || value === 0o755;
}

/** Validates every field required to replay imports and compatibility exports verbatim. */
export function validateReplayRecipe(operation: ExtractTypeDeclarationsOperation, add: AddManifestIssue): void {
  const targetImports = validateImports(operation.targetImports, operation.donor.path, operation.donor.preconditionHash, "target", add);
  validateImports(operation.donorImports, operation.donor.path, operation.donor.preconditionHash, "donor", add);
  validateProvenance(operation.targetImportProofs, targetImports, operation.donor.path, operation.donor.preconditionHash, add);
  validateInlineImportProofs(operation, add);
  const expectedExports = operation.declarations
    .filter((group) => group.declarations.some((selector) => selector.originallyExported))
    .map((group) => group.name)
    .toSorted(byCodeUnit);
  validateSortedStrings(operation.reExportNames, "replay-reexports", "reExportNames", add);
  if (operation.reExportNames.length !== expectedExports.length || operation.reExportNames.some((name, index) => name !== expectedExports[index])) {
    add("replay-reexports", "reExportNames must exactly equal the originally public extracted groups", operation.donor.path);
  }
}

function validateInlineImportProofs(operation: ExtractTypeDeclarationsOperation, add: AddManifestIssue): void {
  const proofs = operation.inlineImportTypeProofs ?? [];
  let previousEnd = -1;
  for (const proof of proofs) {
    if (
      !isRelative(proof.originalSpecifier) ||
      !isRelative(proof.targetSpecifier) ||
      !isWorkspacePath(proof.resolvedSourcePath) ||
      proof.proofBaselineHash !== operation.donor.preconditionHash ||
      !Number.isInteger(proof.start) ||
      !Number.isInteger(proof.end) ||
      proof.start < previousEnd ||
      proof.end <= proof.start ||
      !/^[0-9a-f]{64}$/.test(proof.sourceHash)
    ) {
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
    if (
      !isModuleSpecifier(item.moduleSpecifier) ||
      !isIdentifier(item.localName) ||
      item.requiredAs !== "type" ||
      typeof item.originallyTypeOnly !== "boolean" ||
      item.proofBaselineHash !== baselineHash ||
      !validImportShape(item)
    ) {
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
    if (
      !isRelative(proof.originalSpecifier) ||
      !isRelative(proof.targetSpecifier) ||
      !isWorkspacePath(proof.resolvedSourcePath) ||
      proof.proofBaselineHash !== baselineHash ||
      !imported ||
      !matchesTargetBinding(proof, imported)
    ) {
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
    if (proofCounts.get(binding) !== 1)
      add("target-import-proof", `relative target import ${imported.localName} must have exactly one resolution provenance proof`, path);
  }
}

function matchesTargetBinding(proof: PreparationTargetImportProof, imported: PreparationCheckerProvenTypeImport): boolean {
  return (
    imported.moduleSpecifier === proof.targetSpecifier &&
    imported.localName === proof.localName &&
    imported.importedName === proof.importedName &&
    imported.kind === proof.kind &&
    imported.originallyTypeOnly === proof.originallyTypeOnly &&
    imported.requiredAs === proof.requiredAs &&
    imported.proofBaselineHash === proof.proofBaselineHash
  );
}

function validImportShape(item: PreparationCheckerProvenTypeImport): boolean {
  return (
    (item.kind === "named" && item.importedName !== "default" && isIdentifier(item.importedName)) ||
    (item.kind === "default" && item.importedName === "default") ||
    (item.kind === "namespace" && item.importedName === "*")
  );
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

function isRelative(value: string): boolean {
  return isModuleSpecifier(value) && value.startsWith(".");
}
function isIdentifier(value: string): boolean {
  return typeof value === "string" && /^[$A-Z_a-z][$\w]*$/u.test(value);
}
function isWorkspacePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
function isModuleSpecifier(specifier: string): boolean {
  if (typeof specifier !== "string" || specifier.length === 0 || /[\\\r\n\u0000]/.test(specifier) || specifier.startsWith("/")) return false;
  if (!specifier.startsWith(".")) return true;
  const segments = specifier.split("/");
  let index = segments[0] === "." ? 1 : 0;
  while (segments[index] === "..") index += 1;
  return index > 0 && index < segments.length && segments.slice(index).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
