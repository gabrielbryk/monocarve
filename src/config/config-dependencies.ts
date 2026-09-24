/**
 * The local module closure of an executable config file: every file it
 * imports, transitively, resolved the way Bun would resolve it. Builtins are
 * not files and are skipped; a non-literal or unresolvable import is refused.
 */
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";

import ts from "typescript";

import { InputInventoryError } from "../errors.ts";

export function collectLocalConfigDependencies(path: string, add: (path: string) => void, seen = new Set<string>()): void {
  const absolute = resolve(path);
  if (seen.has(absolute)) return;
  seen.add(absolute);
  add(absolute);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    return;
  }
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    visitConfigDependencyNode(node, source, absolute, add, seen);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function visitConfigDependencyNode(node: ts.Node, source: ts.SourceFile, absolute: string, add: (path: string) => void, seen: Set<string>): void {
  const reference = moduleReferenceOf(node, source);
  if (reference === undefined) return;
  if (!ts.isStringLiteral(reference)) throw new InputInventoryError("ASSESSMENT_INPUT_UNBOUND", `config import cannot be inventoried: ${absolute}`, [absolute]);
  // `fs` and `node:fs` are the same builtin; neither is a file to capture.
  if (reference.text.startsWith("node:") || reference.text.startsWith("bun:") || isBuiltin(reference.text)) return;
  const target = resolveConfigImport(reference.text, absolute);
  collectLocalConfigDependencies(target, add, seen);
}

function moduleReferenceOf(node: ts.Node, source: ts.SourceFile): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require"))
    return node.arguments[0];
  return undefined;
}

function resolveConfigImport(specifier: string, absolute: string): string {
  try {
    return Bun.resolveSync(specifier, dirname(absolute));
  } catch {
    throw new InputInventoryError("ASSESSMENT_INPUT_UNBOUND", `config import cannot be resolved: ${specifier}`, [specifier]);
  }
}
