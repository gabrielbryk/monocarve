/** Target-relative import replay proof for type-only preparation. */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import ts from "typescript";
import type { MonocarveConfig } from "../config.ts";
import { preparationCompilerOptions } from "./compiler-policy.ts";

import { workspacePath } from "../util/paths.ts";
import { assertNoRetainedValueImport, BoundaryProofError } from "./boundary-proofs.ts";
import type { DeleteModuleOperation, ExtractTypeDeclarationsOperation, PreparationReplayOperation } from "./manifest-types.ts";

/**
 * Independent, post-replay re-proof that every importer this manifest
 * rewrote away from a retired shim no longer holds a value-level import into
 * it. `boundary-imports.ts` already proves this at plan time against the
 * baseline text; this re-runs the exact same `assertNoRetainedValueImport`
 * check against the landed bytes, so a build-time proof cannot silently go
 * stale between planning and apply.
 */
export function verifyRetainedRootsClearOfValueImports(rootDir: string, operations: readonly PreparationReplayOperation[], failures: string[]): void {
  const deletions = operations.filter((operation): operation is DeleteModuleOperation => operation.kind === "delete-module");
  for (const deletion of deletions) {
    for (const importerPath of deletion.importerProof) verifyImporterClear(rootDir, deletion, importerPath, failures);
  }
}

function verifyImporterClear(rootDir: string, deletion: DeleteModuleOperation, importerPath: string, failures: string[]): void {
  const text = textAt(rootDir, importerPath);
  if (text === null) {
    failures.push(`retained-root proof cannot read rewritten importer: ${importerPath}`);
    return;
  }
  try {
    assertNoRetainedValueImport(text, importerPath, [deletion.file.path]);
  } catch (error) {
    if (error instanceof BoundaryProofError) failures.push(error.message);
    else throw error;
  }
}

export function verifyTargetImportProofs(
  rootDir: string,
  config: MonocarveConfig,
  extracts: readonly ExtractTypeDeclarationsOperation[],
  baselines: ReadonlyMap<string, Uint8Array>,
  failures: string[],
): void {
  for (const operation of extracts) {
    const baseline = baselines.get(operation.donor.path);
    if (baseline === undefined) continue;
    const donor = new TextDecoder().decode(baseline);
    const target = textAt(rootDir, operation.target.path) ?? operation.targetContents;
    const donorImports = moduleImports(operation.donor.path, donor);
    const targetImports = moduleImports(operation.target.path, target);
    const compilerOptions = preparationCompilerOptions(rootDir, config, operation.donor.path);
    for (const proof of operation.targetImportProofs) verifyProof(rootDir, compilerOptions, operation, donorImports, targetImports, proof, failures);
    for (const proof of operation.inlineImportTypeProofs ?? []) {
      if (!inlineImportTypes(operation.donor.path, donor).has(proof.originalSpecifier))
        failures.push(`inline import proof names no donor import type: ${operation.donor.path}:${proof.originalSpecifier}`);
      if (!inlineImportTypes(operation.target.path, target).has(proof.targetSpecifier))
        failures.push(`inline import type rewrite is absent: ${operation.target.path}:${proof.targetSpecifier}`);
      if (resolveRelativeModule(rootDir, compilerOptions, operation.donor.path, proof.originalSpecifier) !== proof.resolvedSourcePath)
        failures.push(`inline import type proof resolves the donor specifier incorrectly: ${operation.donor.path}:${proof.originalSpecifier}`);
      if (resolveRelativeModule(rootDir, compilerOptions, operation.target.path, proof.targetSpecifier) !== proof.resolvedSourcePath)
        failures.push(`inline import type rewrite resolves to a different module: ${operation.target.path}:${proof.targetSpecifier}`);
    }
  }
}

function inlineImportTypes(path: string, text: string): Set<string> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const result = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.add(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function verifyProof(
  rootDir: string,
  compilerOptions: ts.CompilerOptions,
  operation: ExtractTypeDeclarationsOperation,
  donorImports: ReadonlySet<string>,
  targetImports: ReadonlySet<string>,
  proof: ExtractTypeDeclarationsOperation["targetImportProofs"][number],
  failures: string[],
): void {
  if (proof.proofBaselineHash !== operation.donor.preconditionHash) {
    failures.push(`target import proof used another donor baseline: ${operation.donor.path}:${proof.originalSpecifier}`);
  }
  if (!donorImports.has(proof.originalSpecifier)) {
    failures.push(`target import proof names no donor import: ${operation.donor.path}:${proof.originalSpecifier}`);
  }
  if (!targetImports.has(proof.targetSpecifier)) {
    failures.push(`target import rewrite is absent: ${operation.target.path}:${proof.targetSpecifier}`);
  }
  if (resolveRelativeModule(rootDir, compilerOptions, operation.donor.path, proof.originalSpecifier) !== proof.resolvedSourcePath) {
    failures.push(`target import proof resolves the donor specifier incorrectly: ${operation.donor.path}:${proof.originalSpecifier}`);
  }
  if (resolveRelativeModule(rootDir, compilerOptions, operation.target.path, proof.targetSpecifier) !== proof.resolvedSourcePath) {
    failures.push(`target import rewrite resolves to a different module: ${operation.target.path}:${proof.targetSpecifier}`);
  }
}

function textAt(rootDir: string, path: string): string | null {
  const absolute = workspacePath(rootDir, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function moduleImports(path: string, text: string): Set<string> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  return new Set(
    source.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [],
    ),
  );
}

function resolveRelativeModule(rootDir: string, compilerOptions: ts.CompilerOptions, fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const containingFile = resolve(rootDir, fromPath);
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved === undefined) return undefined;
  return relative(rootDir, resolved).replaceAll("\\", "/");
}
