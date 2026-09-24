/**
 * The tool's own config facade as seen by sandboxed executable config.
 *
 * `monocarve/config` (and the package root, an alias of the same facade) is the tool itself, not
 * a workspace input. Assessment config execution therefore never walks into or
 * captures whatever package the workspace happens to have installed under that
 * name. Inside the sandbox the specifiers resolve to the fixed module below,
 * registered as a Bun virtual module by the sandbox worker. The bytes are part
 * of the running executable, identical whether monocarve runs from source,
 * from `dist/`, or as the standalone binary, and their digest is recorded with
 * the runtime identity of every assessment.
 *
 * Only the runtime value a config needs is provided: `defineConfig`, which is
 * an identity helper (see `src/config/schema.ts`). Types are erased before
 * execution. Any other value import from the facade fails at module link time,
 * so the config fails closed rather than running against a partial facade.
 */
import ts from "typescript";

import { TOOL_NAME } from "../branding.ts";
import { hashBytes, type Sha256 } from "../util/hash.ts";

const CONFIG_FACADE_SPECIFIERS: ReadonlySet<string> = new Set([TOOL_NAME, `${TOOL_NAME}/config`]);

/** Module source served for the facade specifiers inside the config sandbox. */
export const CONFIG_FACADE_SOURCE = "export function defineConfig(config) {\n  return config;\n}\n";

/** Values the sandboxed facade exports; each must be a real export of `src/config.ts`. */
export const CONFIG_FACADE_EXPORTS = ["defineConfig"] as const;

export function isConfigFacadeSpecifier(specifier: string): boolean {
  return CONFIG_FACADE_SPECIFIERS.has(specifier);
}

export function configFacadeSpecifiers(): readonly string[] {
  return [...CONFIG_FACADE_SPECIFIERS];
}

export function configFacadeDigest(): Sha256 {
  return hashBytes(new TextEncoder().encode(CONFIG_FACADE_SOURCE));
}

/**
 * An import or re-export that TypeScript erases entirely: `import type …`,
 * `export type … from`, or an import whose every named binding is `type`.
 * Such a module is never loaded, so it is neither walked nor captured.
 */
export function isErasedModuleDeclaration(node: ts.Node): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
  return clause.name === undefined && named.length > 0 && named.every((item) => item.isTypeOnly);
}
