/**
 * The "port" strategy: promote a type-only declaration out of an app-owned
 * retained module into a portable contract, plus (when the boundary declares
 * one) an app-owned adapter satisfying it. Both artifacts are ordinary
 * `write-file` preparation operations with a real, reviewable diff — the
 * declaration text embedded in the contract is byte-identical to the donor's
 * own declaration span, and the adapter is rendered only from a
 * config-reviewed template, never synthesized ad hoc.
 *
 * What this module refuses: promoting a declaration group `selectors.ts`
 * cannot prove is complete and type-only; a relative type
 * import inside the promoted declaration (no caller-supplied rewrite proof
 * exists for where it resolves from the new contract location, so this is a
 * stop, not a guess); a consumer whose use of the promoted symbol strays
 * into value space; a residual value import of a retained root after
 * rewrite; and an adapter whose rendered surface does not exactly match the
 * declared contract.
 */

import ts from "typescript";

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
  const atomicGroup = boundary.atomicDeclarationGroup === true;
  const selection = selectTypeOnlyDeclarations({
    sourcePath: boundary.retained,
    sourceText: input.retainedSourceText,
    names: boundary.source === "portPromotions" ? boundary.symbols : [boundary.declarationName],
    compilerOptions: input.compilerOptions,
  });
  if (atomicGroup && selection.closureGroupIds.length !== selection.requestedGroupIds.length) {
    throw new BoundaryPortError(
      `port boundary ${boundary.id} requires a closed type-only declaration group; ` + "one or more omitted declarations are required by the selected group",
    );
  }
  if (!atomicGroup && (selection.declarations.length !== 1 || selection.closureGroupIds.length !== 1)) {
    throw new BoundaryPortError(
      `port boundary ${boundary.id} requires exactly one self-contained declaration named ${boundary.declarationName}; ` +
        "it has a type-dependency closure or merge group larger than one",
    );
  }
  if (selection.imports.some((item) => item.moduleSpecifier.startsWith("."))) {
    throw new BoundaryPortError(
      `port boundary ${boundary.id} cannot promote ${boundary.declarationName}: it has a relative type import, which this builder does not rewrite`,
    );
  }
  const contract = writeOperation(
    input.contractTargetPath,
    renderContractModule(selection.declarations, input.retainedSourceText, selection.imports),
    "port-contract",
  );

  const selectedConsumers = input.consumers
    .map((consumer) => ({ consumer, bindings: portImportBindings(consumer, boundary.symbols) }))
    .filter((item) => item.bindings.promoted.length > 0);
  assertTypeOnlyPromotion(
    selectedConsumers.flatMap(({ consumer, bindings }) =>
      bindings.promotedLocals.map((localName) => ({ path: consumer.path, text: consumer.text, localName })),
    ),
  );
  const rewrites = selectedConsumers
    .sort((left, right) => byCodeUnit(left.consumer.path, right.consumer.path))
    .map(({ consumer, bindings }) => planConsumerRewrite(input, consumer, bindings));
  return boundary.appAdapter === undefined ? { contract, rewrites } : { contract, adapter: buildAdapter(input, boundary), rewrites };
}

function renderContractModule(declarations: readonly SelectedTypeDeclaration[], sourceText: string, imports: readonly RequiredImportBinding[]): string {
  const exported = declarations
    .map((declaration) => {
      const body = sourceText.slice(declaration.declaration.start, declaration.declaration.end);
      return declaration.originallyExported ? body : `export ${body}`;
    })
    .join("\n\n");
  const importText = imports.map(renderImportLine).join("\n");
  return importText.length === 0 ? `${exported}\n` : `${importText}\n\n${exported}\n`;
}

function renderImportLine(item: RequiredImportBinding): string {
  const binding =
    item.kind === "default"
      ? item.localName
      : item.kind === "namespace"
        ? `* as ${item.localName}`
        : `{ ${item.importedName === item.localName ? item.importedName : `${item.importedName} as ${item.localName}`} }`;
  return `import type ${binding} from ${JSON.stringify(item.moduleSpecifier)};`;
}

function buildAdapter(input: PlanPortBoundaryInput, boundary: ResolvedPortBoundary): PreparationWriteFileOperation {
  if (boundary.template === undefined || input.adapterTemplateText === undefined) {
    throw new BoundaryPortError(
      `port boundary ${boundary.id} declares an appAdapter but no reviewed template text was supplied; Monocarve never synthesizes adapter code`,
    );
  }
  const appAdapter = boundary.appAdapter;
  if (appAdapter === undefined) throw new BoundaryPortError(`port boundary ${boundary.id} has no configured appAdapter path`);
  const contents = renderTemplate(input.adapterTemplateText, input.templateVars ?? {});
  assertAdapterSurfaceMatchesContract(contents, appAdapter, boundary.symbols);
  return writeOperation(appAdapter, contents, "app-adapter");
}

function planConsumerRewrite(input: PlanPortBoundaryInput, consumer: PortConsumerInput, bindings: PortImportBindings): RewriteModuleSpecifierOperation {
  const { boundary } = input;
  const contents = rewriteSelectedPortImports(consumer, boundary.packageImport, bindings);
  if (contents === consumer.text) {
    throw new BoundaryPortError(`${consumer.path} does not resolve to the retained module ${boundary.retained}; refusing a specifier rewrite with no effect`);
  }
  assertNoRetainedValueImport(contents, consumer.path, boundary.retainedRoots, bindings.retainedLocals);
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
    rewrites: [
      {
        from: consumer.specifier,
        to: boundary.packageImport,
        symbols: bindings.promoted,
        ...(bindings.retained.length === 0 ? {} : { retainedSymbols: bindings.retained }),
      },
    ],
    contents,
  };
}

interface PortImportBindings {
  readonly promoted: readonly string[];
  readonly promotedLocals: readonly string[];
  readonly retained: readonly string[];
  readonly retainedLocals: readonly string[];
  readonly selections: readonly PortImportSelection[];
}

interface PortImportSelection {
  readonly statement: ts.ImportDeclaration;
  readonly promotedElements: readonly ts.ImportSpecifier[];
  readonly retainedElements: readonly ts.ImportSpecifier[];
}

function portImportBindings(consumer: PortConsumerInput, promoted: readonly string[]): PortImportBindings {
  const source = ts.createSourceFile(
    consumer.path,
    consumer.text,
    ts.ScriptTarget.Latest,
    true,
    consumer.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const allowed = new Set(promoted);
  const moved = new Set<string>();
  const movedLocals = new Set<string>();
  const retained = new Set<string>();
  const retainedLocals = new Set<string>();
  const selections: PortImportSelection[] = [];
  let hasSideEffectImport = false;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== consumer.specifier) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!statement.importClause) {
      hasSideEffectImport = true;
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) {
      if (statement.importClause.name) {
        retained.add("default");
        retainedLocals.add(statement.importClause.name.text);
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        retained.add("*");
        retainedLocals.add(bindings.name.text);
      }
      continue;
    }
    const promotedElements: ts.ImportSpecifier[] = [];
    const retainedElements: ts.ImportSpecifier[] = [];
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (allowed.has(imported)) {
        moved.add(imported);
        movedLocals.add(element.name.text);
        promotedElements.push(element);
      } else {
        retained.add(imported);
        retainedLocals.add(element.name.text);
        retainedElements.push(element);
      }
    }
    if (statement.importClause?.name) {
      retained.add("default");
      retainedLocals.add(statement.importClause.name.text);
    }
    if (promotedElements.length > 0) selections.push({ statement, promotedElements, retainedElements });
  }
  if (hasSideEffectImport && selections.length > 0) {
    throw new BoundaryPortError(
      `${consumer.path} has a side-effect import from ${consumer.specifier}; a selective port rewrite cannot prove its retained binding identity`,
    );
  }
  return {
    promoted: [...moved].sort(byCodeUnit),
    promotedLocals: [...movedLocals].sort(byCodeUnit),
    retained: [...retained].sort(byCodeUnit),
    retainedLocals: [...retainedLocals].sort(byCodeUnit),
    selections,
  };
}

function rewriteSelectedPortImports(consumer: PortConsumerInput, packageImport: string, bindings: PortImportBindings): string {
  if (bindings.selections.length === 0) throw new BoundaryPortError(`${consumer.path} has no selected import declaration from ${consumer.specifier}`);
  const edits = bindings.selections
    .map((selection) => selectedImportEdit(consumer, packageImport, selection))
    .sort((left, right) => right.start - left.start || right.end - left.end);
  let contents = consumer.text;
  for (const edit of edits) contents = `${contents.slice(0, edit.start)}${edit.text}${contents.slice(edit.end)}`;
  return contents;
}

function selectedImportEdit(
  consumer: PortConsumerInput,
  packageImport: string,
  selection: PortImportSelection,
): { readonly start: number; readonly end: number; readonly text: string } {
  const { statement, promotedElements, retainedElements } = selection;
  const clause = statement.importClause;
  if (!clause || !ts.isStringLiteral(statement.moduleSpecifier)) {
    throw new BoundaryPortError(`${consumer.path} cannot safely rewrite its selected import from ${consumer.specifier}`);
  }
  if (retainedElements.length === 0 && clause.name === undefined) {
    return { start: statement.moduleSpecifier.getStart(statement.getSourceFile()), end: statement.moduleSpecifier.end, text: JSON.stringify(packageImport) };
  }
  const factory = ts.factory;
  const retainedNamed = retainedElements.length > 0 ? factory.createNamedImports(retainedElements) : undefined;
  const retainedClause = factory.updateImportClause(clause, clause.isTypeOnly, clause.name, retainedNamed);
  const promotedClause = factory.updateImportClause(clause, clause.isTypeOnly, undefined, factory.createNamedImports(promotedElements));
  const retainedImport = factory.updateImportDeclaration(statement, statement.modifiers, retainedClause, statement.moduleSpecifier, statement.attributes);
  const promotedImport = factory.updateImportDeclaration(
    statement,
    statement.modifiers,
    promotedClause,
    factory.createStringLiteral(packageImport),
    statement.attributes,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const source = statement.getSourceFile();
  const replacement = `${printer.printNode(ts.EmitHint.Unspecified, retainedImport, source)}\n${printer.printNode(ts.EmitHint.Unspecified, promotedImport, source)}`;
  return { start: statement.getStart(source), end: statement.end, text: replacement };
}

function writeOperation(path: string, contents: string, purpose: "port-contract" | "app-adapter"): PreparationWriteFileOperation {
  return {
    kind: "write-file",
    file: { path, preconditionHash: MISSING, preconditionMode: "missing", resultHash: hashText(contents), resultMode: 0o644 },
    purpose,
    contents,
  };
}
