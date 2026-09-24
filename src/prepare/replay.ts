/**
 * Pure, byte-oriented renderer for the first writable preparation operation.
 *
 * The seam compiler owns TypeScript checking. This module deliberately does
 * not try to infer imports from text: every synthesized import carries the
 * baseline hash that the compiler checked. That makes a stale checker result a
 * hard refusal instead of a plausible-looking rewrite.
 */

import ts from "typescript";

import { MonocarveError } from "../errors.ts";
import { byCodeUnit, hashJson, hashText, type Sha256 } from "../util/hash.ts";

export type TypeOnlyDeclarationKind = "interface" | "type-alias";

/** An exact, full declaration span. Leading JSDoc belongs in this span. */
export interface TypeOnlyExtractionSpan {
  readonly start: number;
  readonly end: number;
  readonly hash: Sha256;
  readonly name: string;
  readonly kind: TypeOnlyDeclarationKind;
  /** Whether the declaration participated in the donor's public surface. */
  readonly originallyExported: boolean;
}

/**
 * One named `import type` binding which TypeScript has proved is needed.
 *
 * `proofBaselineHash` binds that proof to precisely the source this renderer
 * sees; accepting a proof from a different donor would silently create stale
 * imports after an edit.
 */
export interface CheckerProvenTypeImport {
  readonly moduleSpecifier: string;
  readonly importedName: string | "default" | "*";
  readonly localName: string;
  readonly kind: "default" | "namespace" | "named";
  readonly originallyTypeOnly: boolean;
  readonly requiredAs: "type";
  readonly proofBaselineHash: Sha256;
}

export interface TypeOnlyCompatibilityPolicy {
  /** Exact original public names preserved through `export type { ... }`. */
  readonly reExportNames: readonly string[];
  /** Type references retained by the donor, proven by its TypeScript check. */
  readonly donorImports: readonly CheckerProvenTypeImport[];
}

export interface RenderTypeOnlyExtractionInput {
  readonly baselineText: string;
  readonly baselineHash: Sha256;
  readonly selected: readonly TypeOnlyExtractionSpan[];
  readonly targetPath: string;
  /** The already-resolved specifier by which the donor reaches the target. */
  readonly moduleSpecifier: string;
  /** Type references needed by moved declarations, proven by a checker. */
  readonly targetImports: readonly CheckerProvenTypeImport[];
  readonly inlineImportTypeProofs?: readonly InlineImportTypeRewriteProof[];
  readonly compatibility: TypeOnlyCompatibilityPolicy;
}

export interface InlineImportTypeRewriteProof {
  readonly originalSpecifier: string;
  readonly targetSpecifier: string;
  readonly start: number;
  readonly end: number;
  readonly sourceHash: Sha256;
  readonly proofBaselineHash: Sha256;
}

export interface RenderedPreparationFile {
  readonly text: string;
  readonly hash: Sha256;
}

export interface TypeOnlyExtractionReplay {
  readonly baselineHash: Sha256;
  /** Stable identity for the exact operation, independent of input array order. */
  readonly selectionHash: Sha256;
  readonly donor: RenderedPreparationFile;
  readonly target: RenderedPreparationFile & { readonly path: string };
  /** Exact target ranges proving every source selector's rendered result. */
  readonly declarations: readonly TypeOnlyDeclarationReplayProof[];
}

export interface TypeOnlyDeclarationReplayProof {
  readonly name: string;
  readonly kind: TypeOnlyDeclarationKind;
  readonly source: { readonly start: number; readonly end: number; readonly hash: Sha256 };
  readonly targetSpan: { readonly start: number; readonly end: number; readonly hash: Sha256 };
  readonly targetExtraction: { readonly start: number; readonly end: number; readonly hash: Sha256 };
  readonly synthesizedExport: boolean;
}

/** A pure renderer never mutates a checkout or attempts a git operation. */
export class PreparationReplayError extends MonocarveError {
  override readonly name = "PreparationReplayError";
}

/**
 * Render a type-only extraction from one immutable donor blob.
 *
 * Failure model: a stale span, overlap, non-type declaration, or unproven
 * import must throw. Returning bytes in any of those states would make the
 * later journal replay certify a source the checker never actually approved.
 */
export function renderTypeOnlyExtraction(input: RenderTypeOnlyExtractionInput): TypeOnlyExtractionReplay {
  assertBaseline(input);
  const selected = normalizeSpans(input.baselineText, input.selected);
  const lineEnding = input.baselineText.includes("\r\n") ? "\r\n" : "\n";
  const targetImports = normalizeImports(input.targetImports, input.baselineHash, "target");
  const donorImports = normalizeImports(input.compatibility.donorImports, input.baselineHash, "donor");
  assertDonorImportsTarget(donorImports, input.moduleSpecifier);
  const reExportNames = normalizeReExportNames(input.compatibility.reExportNames, selected);
  const inlineProofs = normalizeInlineImportTypeProofs(input.baselineText, input.baselineHash, selected, input.inlineImportTypeProofs ?? []);

  const moved = selected.map((span) => ({ span, text: renderTargetDeclaration(rewriteInlineImportTypes(input.baselineText, span, inlineProofs), span) }));
  const target = renderTarget(targetImports, moved, lineEnding);
  const donorWithoutDeclarations = removeSpans(input.baselineText, selected);
  const donorAppendix = renderDonorAppendix(input.moduleSpecifier, donorImports, reExportNames, lineEnding);
  const donorText = appendBlock(donorWithoutDeclarations, donorAppendix, lineEnding);
  const selectionHash = hashJson({
    baselineHash: input.baselineHash,
    targetPath: input.targetPath,
    moduleSpecifier: input.moduleSpecifier,
    selected: selected.map(({ start, end, hash, name, kind, originallyExported }) => ({ start, end, hash, name, kind, originallyExported })),
    targetImports,
    donorImports,
    reExportNames,
    inlineProofs,
  });
  return {
    baselineHash: input.baselineHash,
    selectionHash,
    donor: { text: donorText, hash: hashText(donorText) },
    target: { path: input.targetPath, text: target.text, hash: hashText(target.text) },
    declarations: target.declarations,
  };
}

function normalizeInlineImportTypeProofs(
  source: string,
  baselineHash: Sha256,
  selected: readonly TypeOnlyExtractionSpan[],
  proofs: readonly InlineImportTypeRewriteProof[],
): InlineImportTypeRewriteProof[] {
  const sorted = [...proofs].toSorted(
    (left, right) => left.start - right.start || left.end - right.end || byCodeUnit(left.originalSpecifier, right.originalSpecifier),
  );
  let previousEnd = -1;
  for (const proof of sorted) {
    const owner = selected.find((span) => proof.start >= span.start && proof.end <= span.end);
    const literal = source.slice(proof.start, proof.end);
    if (!owner || proof.start < previousEnd || proof.end <= proof.start || proof.proofBaselineHash !== baselineHash || hashText(literal) !== proof.sourceHash) {
      throw new PreparationReplayError("inline import type rewrite proof is stale, overlapping, or outside the selection");
    }
    if (!proof.originalSpecifier.startsWith(".") || !proof.targetSpecifier.startsWith(".") || !isExactStringLiteral(literal, proof.originalSpecifier)) {
      throw new PreparationReplayError("inline import type rewrite proof does not match a relative string literal rewrite");
    }
    previousEnd = proof.end;
  }
  const expected = collectRelativeInlineImportLiterals(source, selected);
  if (
    expected.length !== sorted.length ||
    expected.some(
      (item, index) => item.start !== sorted[index]?.start || item.end !== sorted[index]?.end || item.specifier !== sorted[index]?.originalSpecifier,
    )
  ) {
    throw new PreparationReplayError("relative inline import types require exact rewrite proof coverage");
  }
  return sorted;
}

function collectRelativeInlineImportLiterals(source: string, selected: readonly TypeOnlyExtractionSpan[]): { start: number; end: number; specifier: string }[] {
  const found: { start: number; end: number; specifier: string }[] = [];
  for (const span of selected) {
    const file = ts.createSourceFile("inline-type.ts", source.slice(span.start, span.end), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        node.argument.literal.text.startsWith(".")
      ) {
        found.push({
          start: span.start + node.argument.literal.getStart(file),
          end: span.start + node.argument.literal.end,
          specifier: node.argument.literal.text,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found.sort((left, right) => left.start - right.start || left.end - right.end);
}

function rewriteInlineImportTypes(source: string, span: TypeOnlyExtractionSpan, proofs: readonly InlineImportTypeRewriteProof[]): string {
  const owned = proofs.filter((proof) => proof.start >= span.start && proof.end <= span.end).toSorted((left, right) => right.start - left.start);
  let text = source.slice(span.start, span.end);
  for (const proof of owned) {
    const start = proof.start - span.start;
    text = `${text.slice(0, start)}${JSON.stringify(proof.targetSpecifier)}${text.slice(proof.end - span.start)}`;
  }
  return text;
}

function isExactStringLiteral(text: string, value: string): boolean {
  const source = ts.createSourceFile("literal.ts", `type T = import(${text}).T;`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const alias = source.statements[0];
  if (!alias || !ts.isTypeAliasDeclaration(alias) || !ts.isImportTypeNode(alias.type) || !ts.isLiteralTypeNode(alias.type.argument)) return false;
  return ts.isStringLiteral(alias.type.argument.literal) && alias.type.argument.literal.text === value;
}

function assertBaseline(input: RenderTypeOnlyExtractionInput): void {
  if (hashText(input.baselineText) !== input.baselineHash) {
    throw new PreparationReplayError("baseline hash does not match the supplied donor bytes");
  }
  if (!isRepositoryRelativePath(input.targetPath)) {
    throw new PreparationReplayError("targetPath must be a non-empty repository-relative path");
  }
  if (!isModuleSpecifier(input.moduleSpecifier)) {
    throw new PreparationReplayError("moduleSpecifier must be a non-empty single-line string");
  }
}

function normalizeSpans(source: string, selected: readonly TypeOnlyExtractionSpan[]): TypeOnlyExtractionSpan[] {
  if (selected.length === 0) throw new PreparationReplayError("type-only extraction needs at least one selected declaration");
  const sorted = [...selected].toSorted(compareSpans);
  let previousEnd = -1;
  for (const span of sorted) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > source.length) {
      throw new PreparationReplayError(`selected span for ${span.name} is outside the donor bytes`);
    }
    if (span.start < previousEnd) throw new PreparationReplayError(`selected spans overlap at ${span.name}`);
    if (hashText(source.slice(span.start, span.end)) !== span.hash) {
      throw new PreparationReplayError(`selected span for ${span.name} is stale`);
    }
    assertTypeOnlyDeclaration(source.slice(span.start, span.end), span);
    previousEnd = span.end;
  }
  return sorted;
}

function compareSpans(left: TypeOnlyExtractionSpan, right: TypeOnlyExtractionSpan): number {
  return left.start - right.start || left.end - right.end || byCodeUnit(left.name, right.name) || byCodeUnit(left.hash, right.hash);
}

function assertTypeOnlyDeclaration(text: string, span: TypeOnlyExtractionSpan): void {
  const sourceFile = ts.createSourceFile("extracted-type.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (sourceFile as unknown as { readonly parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length > 0 || sourceFile.statements.length !== 1) {
    throw new PreparationReplayError(`selected span for ${span.name} is not one complete declaration`);
  }
  const statement = sourceFile.statements[0];
  if (!statement) throw new PreparationReplayError(`selected span for ${span.name} is empty`);
  const kind = declarationKind(statement);
  const name = declarationName(statement);
  if (kind !== span.kind || name !== span.name) {
    throw new PreparationReplayError(`selected span for ${span.name} no longer matches its type-only declaration proof`);
  }
  if (hasExportModifier(statement) !== span.originallyExported) {
    throw new PreparationReplayError(`selected span for ${span.name} no longer matches its original export proof`);
  }
  if (hasDeclareModifier(statement) && !span.originallyExported) {
    throw new PreparationReplayError(`selected span for ${span.name} is a non-exported ambient type with potentially global visibility`);
  }
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDeclareModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

function declarationKind(statement: ts.Statement): TypeOnlyDeclarationKind | undefined {
  if (ts.isInterfaceDeclaration(statement)) return "interface";
  if (ts.isTypeAliasDeclaration(statement)) return "type-alias";
  return undefined;
}

function declarationName(statement: ts.Statement): string | undefined {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return statement.name.text;
  return undefined;
}

function normalizeImports(imports: readonly CheckerProvenTypeImport[], baselineHash: Sha256, location: "target" | "donor"): CheckerProvenTypeImport[] {
  const sorted = [...imports].toSorted(compareImports);
  const bindingKeys = new Set<string>();
  const localBindings = new Set<string>();
  for (const item of sorted) {
    if (item.proofBaselineHash !== baselineHash) {
      throw new PreparationReplayError(`${location} import ${item.localName} was not checker-proven against this baseline`);
    }
    if (!isSafeImport(item)) {
      throw new PreparationReplayError(`${location} import ${item.localName} is not a safe named type import`);
    }
    const bindingKey = `${item.moduleSpecifier}\0${item.kind}\0${item.importedName}\0${item.localName}`;
    if (bindingKeys.has(bindingKey) || localBindings.has(item.localName)) {
      throw new PreparationReplayError(`${location} imports contain an ambiguous duplicate binding for ${item.localName}`);
    }
    bindingKeys.add(bindingKey);
    localBindings.add(item.localName);
  }
  return sorted;
}

function compareImports(left: CheckerProvenTypeImport, right: CheckerProvenTypeImport): number {
  return (
    byCodeUnit(left.moduleSpecifier, right.moduleSpecifier) ||
    byCodeUnit(left.kind, right.kind) ||
    byCodeUnit(left.importedName, right.importedName) ||
    byCodeUnit(left.localName, right.localName)
  );
}

function assertDonorImportsTarget(imports: readonly CheckerProvenTypeImport[], targetSpecifier: string): void {
  if (imports.some((item) => item.moduleSpecifier !== targetSpecifier)) {
    throw new PreparationReplayError("donor compatibility imports must point at the extraction target module");
  }
}

function normalizeReExportNames(names: readonly string[], selected: readonly TypeOnlyExtractionSpan[]): string[] {
  const normalized = [...names].toSorted(byCodeUnit);
  if (new Set(normalized).size !== normalized.length || normalized.some((name) => !isIdentifier(name))) {
    throw new PreparationReplayError("compatibility re-export names must be unique identifiers");
  }
  const selectedByName = new Map<string, TypeOnlyExtractionSpan[]>();
  for (const span of selected) {
    const declarations = selectedByName.get(span.name) ?? [];
    declarations.push(span);
    selectedByName.set(span.name, declarations);
  }
  const originalPublicNames = [...selectedByName]
    .filter(([, declarations]) => declarations.some((declaration) => declaration.originallyExported))
    .map(([name]) => name)
    .toSorted(byCodeUnit);
  if (normalized.length !== originalPublicNames.length || normalized.some((name, index) => name !== originalPublicNames[index])) {
    throw new PreparationReplayError("compatibility re-exports must exactly match the selected declarations' original public names");
  }
  return normalized;
}

function renderTargetDeclaration(text: string, span: TypeOnlyExtractionSpan): string {
  if (span.originallyExported) return text;
  const sourceFile = ts.createSourceFile("extracted-type.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = sourceFile.statements[0];
  if (!statement) throw new PreparationReplayError(`selected span for ${span.name} is empty`);
  const declarationStart = statement.getStart(sourceFile);
  return `${text.slice(0, declarationStart)}export ${text.slice(declarationStart)}`;
}

function renderTarget(
  imports: readonly CheckerProvenTypeImport[],
  declarations: readonly { readonly span: TypeOnlyExtractionSpan; readonly text: string }[],
  lineEnding: string,
): { readonly text: string; readonly declarations: readonly TypeOnlyDeclarationReplayProof[] } {
  const importText = renderImports(imports, lineEnding);
  let text = importText.length === 0 ? "" : `${importText}${lineEnding}${lineEnding}`;
  for (const [index, declaration] of declarations.entries()) {
    if (index > 0) text += lineEnding;
    text += declaration.text;
  }
  const rendered = `${text}${lineEnding}`;
  const source = ts.createSourceFile("target-type.ts", rendered, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = source.statements.filter((statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement));
  if (statements.length !== declarations.length) throw new PreparationReplayError("rendered target does not contain one type declaration per selected span");
  const proofs = declarations.map((declaration, index) => {
    const statement = statements[index];
    if (!statement || !matchesRenderedDeclaration(statement, declaration.span)) {
      throw new PreparationReplayError(`rendered target declaration for ${declaration.span.name} does not match its selector`);
    }
    const start = statement.getStart(source);
    const end = statement.end;
    const extractionStart = statement.getFullStart();
    return {
      name: declaration.span.name,
      kind: declaration.span.kind,
      source: { start: declaration.span.start, end: declaration.span.end, hash: declaration.span.hash },
      targetSpan: { start, end, hash: hashText(rendered.slice(start, end)) },
      targetExtraction: { start: extractionStart, end, hash: hashText(rendered.slice(extractionStart, end)) },
      synthesizedExport: !declaration.span.originallyExported,
    };
  });
  return { text: rendered, declarations: proofs };
}

function matchesRenderedDeclaration(statement: ts.Statement, span: TypeOnlyExtractionSpan): boolean {
  return (
    (span.kind === "interface" && ts.isInterfaceDeclaration(statement) && statement.name.text === span.name) ||
    (span.kind === "type-alias" && ts.isTypeAliasDeclaration(statement) && statement.name.text === span.name)
  );
}

function renderDonorAppendix(
  moduleSpecifier: string,
  donorImports: readonly CheckerProvenTypeImport[],
  reExportNames: readonly string[],
  lineEnding: string,
): string {
  const sections = [renderImports(donorImports, lineEnding)];
  if (reExportNames.length > 0) {
    sections.push(`export type { ${reExportNames.join(", ")} } from ${JSON.stringify(moduleSpecifier)};`);
  }
  return sections.filter((section) => section.length > 0).join(lineEnding);
}

function renderImports(imports: readonly CheckerProvenTypeImport[], lineEnding: string): string {
  const groups: { readonly moduleSpecifier: string; readonly bindings: readonly CheckerProvenTypeImport[] }[] = [];
  for (const item of imports) {
    const group = groups[groups.length - 1];
    if (group?.moduleSpecifier === item.moduleSpecifier) {
      groups[groups.length - 1] = { ...group, bindings: [...group.bindings, item] };
    } else {
      groups.push({ moduleSpecifier: item.moduleSpecifier, bindings: [item] });
    }
  }
  return groups.map(({ moduleSpecifier, bindings }) => renderImportGroup(moduleSpecifier, bindings)).join(lineEnding);
}

function renderImportGroup(moduleSpecifier: string, bindings: readonly CheckerProvenTypeImport[]): string {
  const defaults = bindings.filter((item) => item.kind === "default");
  const namespaces = bindings.filter((item) => item.kind === "namespace");
  const named = bindings.filter((item) => item.kind === "named");
  if (defaults.length > 1 || namespaces.length > 1 || (namespaces.length > 0 && named.length > 0)) {
    throw new PreparationReplayError(`checker proof has an unsupported type-import combination for ${moduleSpecifier}`);
  }
  const defaultPart = defaults[0]?.localName;
  const namespacePart = namespaces[0] === undefined ? undefined : `* as ${namespaces[0].localName}`;
  const namedPart =
    named.length === 0
      ? undefined
      : `{ ${named.map(({ importedName, localName }) => (importedName === localName ? importedName : `${importedName} as ${localName}`)).join(", ")} }`;
  const parts = [defaultPart, namespacePart ?? namedPart].filter((item): item is string => item !== undefined);
  return `import type ${parts.join(", ")} from ${JSON.stringify(moduleSpecifier)};`;
}

function removeSpans(source: string, spans: readonly TypeOnlyExtractionSpan[]): string {
  let cursor = 0;
  let result = "";
  for (const span of spans) {
    result += source.slice(cursor, span.start);
    cursor = span.end;
  }
  return result + source.slice(cursor);
}

function appendBlock(source: string, block: string, lineEnding: string): string {
  if (block.length === 0) return source;
  const separator = source.length === 0 ? "" : source.endsWith(lineEnding) ? lineEnding : `${lineEnding}${lineEnding}`;
  return `${source}${separator}${block}${lineEnding}`;
}

function isRepositoryRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.startsWith("\\") && !value.split(/[\\/]/).includes("..");
}

function isModuleSpecifier(value: string): boolean {
  return value.length > 0 && !/[\r\n]/.test(value);
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value);
}

function isSafeImport(item: CheckerProvenTypeImport): boolean {
  if (!isModuleSpecifier(item.moduleSpecifier) || !isIdentifier(item.localName) || item.requiredAs !== "type") return false;
  if (item.kind === "default") return item.importedName === "default";
  if (item.kind === "namespace") return item.importedName === "*";
  return isIdentifier(item.importedName);
}
