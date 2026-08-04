/**
 * The "port" strategy: promote a type-only declaration out of an app-owned
 * retained module into a portable contract, plus (when the boundary declares
 * one) an app-owned adapter satisfying it. Both artifacts are ordinary
 * `write-file` preparation operations with a real, reviewable diff — the
 * declaration text embedded in the contract is byte-identical to the donor's
 * own declaration span, and the adapter is rendered only from a
 * config-reviewed template, never synthesized ad hoc.
 *
 * What this module refuses: promoting a declaration `selectors.ts` cannot
 * prove is a complete, type-only, single-declaration unit; a relative type
 * import inside the promoted declaration (no caller-supplied rewrite proof
 * exists for where it resolves from the new contract location, so this is a
 * stop, not a guess); a consumer whose use of the promoted symbol strays
 * into value space; a residual value import of a retained root after
 * rewrite; and an adapter whose rendered surface does not exactly match the
 * declared contract.
 */

import { resolve } from "node:path";

import ts from "typescript";

import { rewriteResolvedImportSpecifier } from "../codemod/imports.ts";
import { MonocarveError } from "../errors.ts";
import { byCodeUnit, hashText, MISSING, type FileState } from "../util/hash.ts";
import { renderTemplate, type TemplateVars } from "../util/template.ts";
import { assertAdapterSurfaceMatchesContract, assertNoRetainedValueImport, assertTypeOnlyPromotion } from "./boundary-proofs.ts";
import type { ResolvedPortBoundary } from "./boundary-resolve.ts";
import type { PreparationFileMutation, PreparationWriteFileOperation, RewriteModuleSpecifierOperation } from "./manifest-types.ts";
import { selectTypeOnlyDeclarations, type RequiredImportBinding, type SelectedTypeDeclaration } from "./selectors.ts";

export class BoundaryPortError extends MonocarveError {
  override readonly name = "BoundaryPortError";
}

/** One consumer that must be rewired from the retained module to the port. */
export interface PortConsumerInput {
  readonly path: string;
  readonly preconditionHash: FileState;
  readonly mode: number;
  readonly text: string;
  /** Exact specifier this consumer currently uses to reach the retained module. */
  readonly specifier: string;
}

export interface PlanPortBoundaryInput {
  readonly rootDir: string;
  readonly boundary: ResolvedPortBoundary;
  readonly retainedSourceText: string;
  readonly compilerOptions: ts.CompilerOptions;
  /** Repo-relative destination for the promoted contract module; must not exist at baseline. */
  readonly contractTargetPath: string;
  readonly consumers: readonly PortConsumerInput[];
  /** Reviewed template body, resolved by the caller from `boundary.template`. */
  readonly adapterTemplateText?: string;
  readonly templateVars?: TemplateVars;
  readonly moduleSpecifierCalls?: readonly string[];
  readonly resolutionExtensions?: readonly string[];
  readonly cssImportExtensions?: readonly string[];
}

export interface PlanPortBoundaryResult {
  readonly contract: PreparationWriteFileOperation;
  readonly adapter?: PreparationWriteFileOperation;
  readonly rewrites: readonly RewriteModuleSpecifierOperation[];
}

/** Compile the full operation set for one "port" boundary. */
export function planPortBoundary(input: PlanPortBoundaryInput): PlanPortBoundaryResult {
  const { boundary } = input;
  const selection = selectTypeOnlyDeclarations({
    sourcePath: boundary.retained,
    sourceText: input.retainedSourceText,
    names: [boundary.declarationName],
    compilerOptions: input.compilerOptions,
  });
  if (selection.declarations.length !== 1 || selection.closureGroupIds.length !== 1) {
    throw new BoundaryPortError(
      `port boundary ${boundary.id} requires exactly one self-contained declaration named ${boundary.declarationName}; ` +
        "it has a type-dependency closure or merge group larger than one",
    );
  }
  if (selection.imports.some((item) => item.moduleSpecifier.startsWith("."))) {
    throw new BoundaryPortError(`port boundary ${boundary.id} cannot promote ${boundary.declarationName}: it has a relative type import, which this builder does not rewrite`);
  }
  const declaration = selection.declarations[0]!;
  const contract = writeOperation(input.contractTargetPath, renderContractModule(declaration, input.retainedSourceText, selection.imports), "port-contract");

  assertTypeOnlyPromotion(input.consumers.map((consumer) => ({ path: consumer.path, text: consumer.text, localName: boundary.contractName })));
  const rewrites = [...input.consumers]
    .sort((left, right) => byCodeUnit(left.path, right.path))
    .map((consumer) => planConsumerRewrite(input, consumer));
  return boundary.appAdapter === undefined ? { contract, rewrites } : { contract, adapter: buildAdapter(input, boundary), rewrites };
}

function renderContractModule(
  declaration: SelectedTypeDeclaration,
  sourceText: string,
  imports: readonly RequiredImportBinding[],
): string {
  const body = sourceText.slice(declaration.declaration.start, declaration.declaration.end);
  const exported = declaration.originallyExported ? body : `export ${body}`;
  const importText = imports.map(renderImportLine).join("\n");
  return importText.length === 0 ? `${exported}\n` : `${importText}\n\n${exported}\n`;
}

function renderImportLine(item: RequiredImportBinding): string {
  const binding = item.kind === "default"
    ? item.localName
    : item.kind === "namespace"
      ? `* as ${item.localName}`
      : `{ ${item.importedName === item.localName ? item.importedName : `${item.importedName} as ${item.localName}`} }`;
  return `import type ${binding} from ${JSON.stringify(item.moduleSpecifier)};`;
}

function buildAdapter(input: PlanPortBoundaryInput, boundary: ResolvedPortBoundary): PreparationWriteFileOperation {
  if (boundary.template === undefined || input.adapterTemplateText === undefined) {
    throw new BoundaryPortError(`port boundary ${boundary.id} declares an appAdapter but no reviewed template text was supplied; Monocarve never synthesizes adapter code`);
  }
  const appAdapter = boundary.appAdapter;
  if (appAdapter === undefined) throw new BoundaryPortError(`port boundary ${boundary.id} has no configured appAdapter path`);
  const contents = renderTemplate(input.adapterTemplateText, input.templateVars ?? {});
  assertAdapterSurfaceMatchesContract(contents, appAdapter, boundary.symbols);
  return writeOperation(appAdapter, contents, "app-adapter");
}

function planConsumerRewrite(input: PlanPortBoundaryInput, consumer: PortConsumerInput): RewriteModuleSpecifierOperation {
  const { boundary, rootDir } = input;
  const donorPath = resolve(rootDir, boundary.retained);
  const contents = rewriteResolvedImportSpecifier(
    consumer.text,
    resolve(rootDir, consumer.path),
    donorPath,
    boundary.packageImport,
    rootDir,
    input.moduleSpecifierCalls ?? [],
    input.resolutionExtensions ?? [],
    input.cssImportExtensions ?? [],
  );
  if (contents === consumer.text) {
    throw new BoundaryPortError(`${consumer.path} does not resolve to the retained module ${boundary.retained}; refusing a specifier rewrite with no effect`);
  }
  assertNoRetainedValueImport(contents, consumer.path, boundary.retainedRoots);
  const file: PreparationFileMutation = {
    path: consumer.path,
    preconditionHash: consumer.preconditionHash,
    preconditionMode: consumer.mode,
    resultHash: hashText(contents),
    resultMode: consumer.mode,
  };
  return {
    kind: "rewrite-module-specifier",
    file,
    rewrites: [{ from: consumer.specifier, to: boundary.packageImport, symbols: [boundary.contractName] }],
    contents,
  };
}

function writeOperation(path: string, contents: string, purpose: "port-contract" | "app-adapter"): PreparationWriteFileOperation {
  return {
    kind: "write-file",
    file: { path, preconditionHash: MISSING, preconditionMode: "missing", resultHash: hashText(contents), resultMode: 0o644 },
    purpose,
    contents,
  };
}
