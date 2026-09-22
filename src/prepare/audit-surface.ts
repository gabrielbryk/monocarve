/** Type-checker proof that compatibility exports resolve to the extracted type module. */

import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import type { MonocarveConfig } from "../config.ts";
import { preparationCompilerOptions } from "./compiler-policy.ts";

import { workspacePath } from "../util/paths.ts";
import { assertAdapterSurfaceMatchesContract } from "./boundary-proofs.ts";
import type {
  CompatibilityReexportIntent,
  ExtractTypeDeclarationsOperation,
  PreparationReplayOperation,
  PreparationWriteFileOperation,
} from "./manifest-types.ts";

/**
 * Independent, post-replay re-proof that a boundary's app-owned adapter
 * exports exactly the surface its own promoted contract declares — reusing
 * `assertAdapterSurfaceMatchesContract` rather than re-deriving the check.
 * The expected surface is read from the contract's own landed bytes, never
 * from config, so this stays a proof about what was actually committed.
 *
 * A manifest naming more than one `port-contract` or `app-adapter` write
 * leaves the pairing between them genuinely undetermined from the manifest
 * alone; Monocarve never guesses a pairing it was not told, so this proof
 * only runs for the unambiguous single-boundary case.
 */
export function verifyAdapterSurfaceAgainstContract(rootDir: string, operations: readonly PreparationReplayOperation[], failures: string[]): void {
  const writes = operations.filter((operation): operation is PreparationWriteFileOperation => operation.kind === "write-file");
  const contracts = writes.filter((operation) => operation.purpose === "port-contract");
  const adapters = writes.filter((operation) => operation.purpose === "app-adapter");
  if (contracts.length !== 1 || adapters.length !== 1) return;
  const contract = contracts[0]!;
  const adapter = adapters[0]!;
  const contractText = textAt(rootDir, contract.file.path) ?? contract.contents;
  const adapterText = textAt(rootDir, adapter.file.path) ?? adapter.contents;
  const symbols = exportedTopLevelNames(contract.file.path, contractText);
  try {
    assertAdapterSurfaceMatchesContract(adapterText, adapter.file.path, symbols);
  } catch (error) {
    failures.push((error as Error).message);
  }
}

function exportedTopLevelNames(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const statement of source.statements) {
    const name = exportedDeclarationName(statement);
    if (name) names.push(name);
  }
  return names;
}

function exportedDeclarationName(statement: ts.Statement): string | undefined {
  if (!ts.canHaveModifiers(statement) || !(ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    return undefined;
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

function textAt(rootDir: string, path: string): string | null {
  const absolute = workspacePath(rootDir, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

/** Refuse an extra target type declaration that has no selector-bound replay proof. */
export function verifyTargetDeclarationCoverage(rootDir: string, operation: ExtractTypeDeclarationsOperation, failures: string[]): void {
  const path = workspacePath(rootDir, operation.target.path);
  if (!existsSync(path)) {
    failures.push(`target declaration coverage cannot read missing file: ${operation.target.path}`);
    return;
  }
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(operation.target.path, text, ts.ScriptTarget.Latest, true);
  const selectorIds = new Set(operation.declarations.flatMap((group) => group.declarations.map((item) => item.selectorId)));
  const proofs = new Map(operation.targetDeclarationProofs.map((proof) => [`${proof.targetStart}:${proof.targetEnd}`, proof]));
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
    const proof = proofs.get(`${statement.getStart(source)}:${statement.end}`);
    if (!proof || !selectorIds.has(proof.selectorId)) {
      failures.push(`target contains an unproven type declaration: ${operation.target.path}:${ts.SyntaxKind[statement.kind]}`);
    }
  }
  for (const proof of operation.targetDeclarationProofs) {
    const statement = source.statements.find((item) => item.getStart(source) === proof.targetStart && item.end === proof.targetEnd);
    if (!statement || (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement))) {
      failures.push(`target declaration proof has no physical type declaration: ${operation.target.path}:${proof.selectorId}`);
    }
  }
}

export function verifyRenderedCompatibilitySurface(
  source: ts.SourceFile,
  intent: CompatibilityReexportIntent,
  failures: string[],
  typeFailures: string[],
): void {
  const expected = new Set(intent.exports.map((item) => item.name));
  const actual = new Set<string>();
  for (const statement of source.statements) {
    if (!matchesSpecifier(statement, intent.moduleSpecifier)) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      failures.push(`compatibility surface uses an unbounded re-export: ${intent.fromPath}`);
      continue;
    }
    for (const item of statement.exportClause.elements) {
      actual.add(item.name.text);
      if (!statement.isTypeOnly && !item.isTypeOnly) typeFailures.push(`compatibility surface contains a value export: ${intent.fromPath}:${item.name.text}`);
    }
  }
  for (const name of actual) if (!expected.has(name)) failures.push(`compatibility surface exposes an undeclared name: ${intent.fromPath}:${name}`);
  for (const name of expected) if (!actual.has(name)) failures.push(`compatibility surface omits a declared name: ${intent.fromPath}:${name}`);
}

export function verifyCompatibilityResolution(rootDir: string, config: MonocarveConfig, intent: CompatibilityReexportIntent, failures: string[]): void {
  const donorPath = workspacePath(rootDir, intent.fromPath);
  const targetPath = workspacePath(rootDir, intent.toPath);
  const donorText = readFileSync(donorPath, "utf8");
  const targetText = readFileSync(targetPath, "utf8");
  const program = compatibilityProgram(rootDir, config, intent.fromPath, donorPath, donorText, targetPath, targetText);
  const checker = program.getTypeChecker();
  const donor = program.getSourceFile(donorPath);
  const target = program.getSourceFile(targetPath);
  if (!donor || !target) {
    failures.push(`compatibility checker could not load module pair: ${intent.fromPath}`);
    return;
  }
  const donorSymbol = checker.getSymbolAtLocation(donor);
  const targetSymbol = checker.getSymbolAtLocation(target);
  if (!donorSymbol || !targetSymbol) {
    failures.push(`compatibility checker could not resolve module symbols: ${intent.fromPath}`);
    return;
  }
  const donorExports = new Map(checker.getExportsOfModule(donorSymbol).map((item) => [item.name, item]));
  const targetExports = new Map(checker.getExportsOfModule(targetSymbol).map((item) => [item.name, item]));
  for (const claim of intent.exports) verifyClaim(checker, claim.name, donorExports, targetExports, intent, failures);
}

function verifyClaim(
  checker: ts.TypeChecker,
  name: string,
  donorExports: ReadonlyMap<string, ts.Symbol>,
  targetExports: ReadonlyMap<string, ts.Symbol>,
  intent: CompatibilityReexportIntent,
  failures: string[],
): void {
  const donor = donorExports.get(name);
  const target = targetExports.get(name);
  if (!donor || !target) {
    failures.push(`compatibility export does not resolve from donor to target: ${intent.fromPath}:${name}`);
    return;
  }
  const resolvedDonor = resolveAlias(checker, donor);
  const resolvedTarget = resolveAlias(checker, target);
  if (resolvedDonor !== resolvedTarget) {
    failures.push(`compatibility export resolves to a different target symbol: ${intent.fromPath}:${name}`);
  }
  if ((resolvedTarget.flags & ts.SymbolFlags.Value) !== 0) {
    failures.push(`compatibility export resolves to a value symbol: ${intent.fromPath}:${name}`);
  }
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
}

function compatibilityProgram(
  rootDir: string,
  config: MonocarveConfig,
  sourcePath: string,
  donorPath: string,
  donorText: string,
  targetPath: string,
  targetText: string,
): ts.Program {
  const texts = new Map([
    [donorPath, donorText],
    [targetPath, targetText],
  ]);
  const options: ts.CompilerOptions = { ...preparationCompilerOptions(rootDir, config, sourcePath), noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const originalSource = host.getSourceFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalRead = host.readFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreate) => {
    const text = texts.get(path);
    return text === undefined ? originalSource(path, languageVersion, onError, shouldCreate) : ts.createSourceFile(path, text, languageVersion, true);
  };
  host.fileExists = (path) => texts.has(path) || originalExists(path);
  host.readFile = (path) => texts.get(path) ?? originalRead(path);
  return ts.createProgram([donorPath, targetPath], options, host);
}

function matchesSpecifier(statement: ts.Statement, moduleSpecifier: string): statement is ts.ExportDeclaration {
  if (!ts.isExportDeclaration(statement)) return false;
  const specifier = statement.moduleSpecifier;
  if (!specifier) return false;
  return ts.isStringLiteral(specifier) && specifier.text === moduleSpecifier;
}
