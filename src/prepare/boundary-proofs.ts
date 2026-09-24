/**
 * Proof obligations the "port" strategy (`src/prepare/boundary-port.ts`) must
 * discharge before it can emit an ordinary write-file/rewrite-module-specifier
 * operation set. Each function inspects real TypeScript syntax against the
 * checker's reference-space classification (`referenceSpace`) rather than
 * trusting config policy — the governing constraint is that Monocarve
 * validates a reviewer-declared substitution, it never invents or assumes
 * one, so every one of these is a hard refusal, never a warning.
 */

import { posix } from "node:path";

import ts from "typescript";

import { MonocarveError } from "../errors.ts";
import { referenceSpace } from "../symbols/analyze.ts";

export class BoundaryProofError extends MonocarveError {
  override readonly name = "BoundaryProofError";
}

/** One consumer file's baseline text, scanned for uses of one imported local name. */
export interface PromotionConsumerSource {
  readonly path: string;
  readonly text: string;
  readonly localName: string;
}

/**
 * Every reference to `localName` in each consumer must be in TYPE space.
 * A single value-space use — `new Db()`, a runtime property access, an
 * argument position expecting a value — proves the symbol is not actually a
 * pure contract, no matter what the config declares it to be.
 */
export function assertTypeOnlyPromotion(consumers: readonly PromotionConsumerSource[]): void {
  for (const consumer of consumers) {
    const file = ts.createSourceFile(consumer.path, consumer.text, ts.ScriptTarget.Latest, true, scriptKind(consumer.path));
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === consumer.localName && !isBindingName(node) && referenceSpace(node) !== "type") {
        throw new BoundaryProofError(`${consumer.path} uses ${consumer.localName} in value space; a port promotion requires every use to be type-only`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
}

/**
 * No import statement in `rewrittenText` may still bring in a value binding
 * from any `retainedRoots` prefix. A promotion that leaves one relative value
 * import pointed at the app is not a promotion — the "port" would still be
 * secretly coupled to the concrete app module it was supposed to replace.
 *
 * Relative specifiers are resolved by pure path arithmetic against
 * `importerPath`, never the filesystem: a specifier this cannot prove is
 * under a retained root is never treated as a false refusal, only left
 * unchecked, because a pure proof must not depend on what happens to exist
 * on disk at compile time.
 */
export function assertNoRetainedValueImport(
  rewrittenText: string,
  importerPath: string,
  retainedRoots: readonly string[],
  allowedRetainedBindings: readonly string[] = [],
): void {
  const file = ts.createSourceFile(importerPath, rewrittenText, ts.ScriptTarget.Latest, true, scriptKind(importerPath));
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (!retainedRoots.some((root) => underRetainedRoot(importerPath, specifier, root))) continue;
    const namedBindings = statement.importClause?.namedBindings;
    const namedTypeOnly = namedBindings !== undefined && ts.isNamedImports(namedBindings) && namedBindings.elements.every((element) => element.isTypeOnly);
    if (namedTypeOnly) continue;
    const actual = importLocalBindings(statement);
    const allowed = new Set(allowedRetainedBindings);
    if (actual.length === 0 || actual.some((name) => !allowed.has(name))) {
      throw new BoundaryProofError(`${importerPath} still imports a value binding from retained root ${specifier} after promotion`);
    }
  }
}

function importLocalBindings(statement: ts.ImportDeclaration): string[] {
  const clause = statement.importClause;
  if (!clause) return [];
  const result = clause.name ? [clause.name.text] : [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) result.push(bindings.name.text);
  if (bindings && ts.isNamedImports(bindings)) result.push(...bindings.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text));
  return result;
}

function underRetainedRoot(importerPath: string, specifier: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (!specifier.startsWith(".")) return specifier === normalizedRoot || specifier.startsWith(`${normalizedRoot}/`);
  const resolved = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`) || resolved.startsWith(`${normalizedRoot}.`);
}

/**
 * The rendered app adapter's exported surface must be exactly the contract's
 * declared symbol list — no more, no less. A wider surface would let a
 * portable consumer reach something the contract never promised; a narrower
 * one means the adapter does not actually implement the contract.
 */
export function assertAdapterSurfaceMatchesContract(adapterText: string, adapterPath: string, contractSymbols: readonly string[]): void {
  const file = ts.createSourceFile(adapterPath, adapterText, ts.ScriptTarget.Latest, true, scriptKind(adapterPath));
  const exported = new Set<string>();
  for (const statement of file.statements) {
    const name = exportedName(statement);
    if (name) exported.add(name);
  }
  const expected = new Set(contractSymbols);
  const missing = contractSymbols.filter((name) => !exported.has(name));
  const extra = [...exported].filter((name) => !expected.has(name)).toSorted();
  if (missing.length > 0 || extra.length > 0) {
    throw new BoundaryProofError(
      `adapter ${adapterPath} surface does not match its contract` +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; unexpected: ${extra.join(", ")}` : ""),
    );
  }
}

function exportedName(statement: ts.Statement): string | undefined {
  if (!ts.canHaveModifiers(statement) || !(ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return undefined;
  }
  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations[0];
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text;
  }
  return undefined;
}

function isBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent);
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}
