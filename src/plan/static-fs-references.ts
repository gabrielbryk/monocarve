/**
 * Static filesystem references: a source file named by a string literal passed
 * through `resolve(import.meta.dir, <literal>)` — directly, or via a local
 * single-parameter helper that closes over `import.meta.dir` — rather than by
 * a module specifier.
 *
 * `readFileSync(resolve(import.meta.dir, "../x.ts"), "utf8")` never appears in
 * `codemod/imports.ts`'s inventory: it is not an `import`, `require`, or
 * configured call, so the file it names is invisible to the import graph, to
 * consumer discovery, and to every codemod that rewrites specifiers. When the
 * named file moves, the literal still resolves against the *old* location and
 * the read fails at runtime — a failure mode `path-references.ts` can only
 * warn about, because a bare relative literal's base is not knowable in
 * general. This one construct is the exception: `import.meta.dir` fixes the
 * base to the importing file's own directory, which makes the literal
 * statically resolvable, not just path-shaped.
 *
 * Scope is deliberately narrow. Only the exact `resolve(import.meta.dir, …)`
 * call, and only a same-file local helper of the shape
 * `const NAME = (param) => … resolve(import.meta.dir, param) …`, are
 * recognised. A computed argument to a call this module does not recognise is
 * left alone — never guessed at, never rewritten.
 */

import ts from "typescript";
import { dirname, resolve } from "node:path";

import { applyReplacements, fitsInLiteral } from "../codemod/imports.ts";
import { relativePosix } from "../util/paths.ts";

/** One `resolve(import.meta.dir, "literal")`-shaped reference in a file. */
export interface StaticFsReferenceMatch {
  /** The literal's text, unquoted. */
  readonly literal: string;
  /** Where the literal resolves, absolute — computed from the file's own directory. */
  readonly resolvedAbsolute: string;
  /** Offsets of the literal token itself, delimiters included. */
  readonly span: { readonly start: number; readonly end: number };
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  return filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** `import.meta.dir` — the one base this module treats as statically known. */
function isImportMetaDir(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "dir" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta"
  );
}

function isNodePathModuleSpecifier(text: string): boolean {
  return text === "node:path" || text === "path";
}

/** Node whose direct child statements/parameters can declare a lexical binding. */
function isFunctionLikeScope(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function isScopeNode(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isCatchClause(node) || isFunctionLikeScope(node);
}

/** The declaration a `name` binding resolves to if introduced directly by `scope` (not a nested scope). */
function declarationInScope(scope: ts.Node, name: string): ts.Node | undefined {
  if (ts.isCatchClause(scope)) {
    const decl = scope.variableDeclaration;
    return decl && ts.isIdentifier(decl.name) && decl.name.text === name ? decl : undefined;
  }
  if (isFunctionLikeScope(scope)) {
    if ((ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) && scope.name?.text === name) return scope;
    for (const parameter of scope.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return parameter;
    }
    return undefined;
  }
  if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) return undefined;
  for (const statement of scope.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return statement;
    } else if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      return statement;
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name?.text === name) return clause;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) return bindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if (specifier.name.text === name) return specifier;
        }
      }
    }
  }
  return undefined;
}

/**
 * The nearest lexical declaration of `name` reachable from `useNode`, walking
 * enclosing blocks, function parameter lists, and the source file itself —
 * innermost first, so a shadowing declaration always wins over an outer one.
 * Not full dataflow (var hoisting and TDZ ordering are not modelled), but
 * enough to tell a same-named local from the binding a helper or `resolve`
 * call actually closes over.
 */
function resolveLexicalDeclaration(useNode: ts.Node, name: string): ts.Node | undefined {
  let node: ts.Node | undefined = useNode.parent;
  while (node) {
    if (isScopeNode(node)) {
      const decl = declarationInScope(node, name);
      if (decl) return decl;
    }
    node = node.parent;
  }
  return undefined;
}

function importDeclarationOf(node: ts.Node): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current;
}

/**
 * Whether the identifier `resolve` at this use site is demonstrably Node's
 * `path.resolve` — a named `resolve` import from `node:path`/`path` — rather
 * than some unrelated local of the same name, or nothing this module can
 * verify at all. An identifier with no declaration reachable in scope is not
 * demonstrably `node:path`'s resolve, so it is refused, the same as a
 * provable shadow: a local variable, parameter, or function literally named
 * `resolve`.
 */
function identifierIsNodePathResolve(expression: ts.Identifier): boolean {
  const decl = resolveLexicalDeclaration(expression, expression.text);
  if (!decl) return false;
  if (!ts.isImportSpecifier(decl)) return false;
  const importedName = decl.propertyName ?? decl.name;
  if (importedName.text !== "resolve") return false;
  const importDecl = importDeclarationOf(decl);
  return importDecl !== undefined && ts.isStringLiteral(importDecl.moduleSpecifier) && isNodePathModuleSpecifier(importDecl.moduleSpecifier.text);
}

/** Whether `expression` is a namespace import identifier bound to `node:path`/`path`, for `path.resolve(…)`. */
function identifierIsNodePathNamespace(expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false;
  const decl = resolveLexicalDeclaration(expression, expression.text);
  if (!decl || !ts.isNamespaceImport(decl)) return false;
  const importDecl = importDeclarationOf(decl);
  return importDecl !== undefined && ts.isStringLiteral(importDecl.moduleSpecifier) && isNodePathModuleSpecifier(importDecl.moduleSpecifier.text);
}

/** `resolve(…)` or `path.resolve(…)`, demonstrably Node's `path.resolve` at this use site. */
function isResolveCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "resolve" && identifierIsNodePathResolve(expression);
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "resolve" &&
    identifierIsNodePathNamespace(expression.expression)
  );
}

function literalTextOf(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** String literals in `for (const name of ["…"])`, when `name` is the helper argument. */
function forOfLiteralBinding(node: ts.Expression): readonly ts.Expression[] | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  let parent: ts.Node | undefined = node.parent;
  while (parent && !ts.isForOfStatement(parent)) parent = parent.parent;
  if (!parent || !ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer)) return undefined;
  const declaration = parent.initializer.declarations.length === 1 ? parent.initializer.declarations[0] : undefined;
  if (!declaration || !ts.isIdentifier(declaration.name) || declaration.name.text !== node.text || !ts.isArrayLiteralExpression(parent.expression)) return undefined;
  return parent.expression.elements.filter((element): element is ts.Expression => ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element));
}

/**
 * Local `const NAME = (param) => …` declarations whose body calls
 * `resolve(import.meta.dir, param)` with that same parameter — the
 * `const read = (path) => readFileSync(resolve(import.meta.dir, path), "utf8")`
 * idiom. Single-parameter only. Returned as the declaration nodes themselves
 * (not names) so a call site must resolve, lexically, to this exact
 * declaration to count as a helper call — a same-named but shadowed or
 * unrelated binding does not.
 */
function resolveHelperDeclarations(root: ts.Node): ReadonlySet<ts.VariableDeclaration> {
  const helpers = new Set<ts.VariableDeclaration>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const fn = node.initializer;
      const parameter = fn.parameters.length === 1 ? fn.parameters[0] : undefined;
      if (parameter && ts.isIdentifier(parameter.name) && callsResolveWithParameter(fn.body, parameter.name.text)) {
        helpers.add(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return helpers;
}

function callsResolveWithParameter(body: ts.Node, parameterName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && isResolveCallee(node.expression) && node.arguments.length >= 2) {
      const [first, second] = node.arguments;
      if (first && second && isImportMetaDir(first) && ts.isIdentifier(second) && second.text === parameterName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * Every static filesystem reference in `source`. `filePath` fixes the base:
 * an absolute path, or one resolvable against the process's own cwd — a
 * workspace-relative path is not by itself enough, so callers pass an
 * absolute path (`WorkspaceContext.absolute(file)`).
 */
export function findStaticFsReferences(source: string, filePath: string): StaticFsReferenceMatch[] {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const helpers = resolveHelperDeclarations(file);
  const directory = dirname(filePath);
  const matches: StaticFsReferenceMatch[] = [];

  const record = (node: ts.Node): void => {
    const literal = literalTextOf(node);
    if (literal === null) return;
    matches.push({
      literal,
      resolvedAbsolute: resolve(directory, literal),
      span: { start: node.getStart(file), end: node.end },
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isResolveCallee(node.expression) && node.arguments.length >= 2) {
        const [first, second] = node.arguments;
        if (first && second && isImportMetaDir(first)) {
          const literals = forOfLiteralBinding(second);
          if (literals) literals.forEach(record);
          else record(second);
        }
      } else if (ts.isIdentifier(node.expression) && node.arguments.length === 1) {
        const declaration = resolveLexicalDeclaration(node.expression, node.expression.text);
        if (declaration && ts.isVariableDeclaration(declaration) && helpers.has(declaration)) {
          const argument = node.arguments[0]!;
          const literals = forOfLiteralBinding(argument);
          if (literals) literals.forEach(record);
          else record(argument);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return matches;
}

/**
 * Repoint every static filesystem reference in `source` that resolves to
 * `donorAbsolutePath` at `newLiteral`, preserving the original quote style and
 * every other byte — the same splice discipline as
 * `rewriteResolvedImportSpecifier`, and for the same reason: the audit's
 * replay proof only holds if this is the exact function that produced the
 * bytes it re-derives.
 */
export function rewriteStaticFsReference(
  source: string,
  filePath: string,
  donorAbsolutePath: string,
  newLiteral: string,
): string {
  const replacements = findStaticFsReferences(source, filePath)
    .filter((match) => match.resolvedAbsolute === donorAbsolutePath)
    .map((match) => {
      const delimiter = source.slice(match.span.start, match.span.start + 1);
      if (!fitsInLiteral(newLiteral, delimiter)) {
        throw new Error(
          `cannot rewrite ${filePath}: the literal ${JSON.stringify(newLiteral)} cannot be written inside ` +
            `${JSON.stringify(source.slice(match.span.start, match.span.end))}`,
        );
      }
      return { start: match.span.start + 1, end: match.span.end - 1, text: newLiteral };
    });
  return applyReplacements(source, replacements);
}

/**
 * The relative literal a static filesystem reference in `fromFile` must carry
 * to reach `toPath`, both workspace-relative. Always forward-slashed and
 * always prefixed — `chart.ts`, not `./chart.ts`, is a bare specifier the
 * `resolve()` this module targets would treat identically, but it is not the
 * shape a relative-path literal is conventionally written in.
 */
export function relativeFsLiteral(fromFile: string, toPath: string): string {
  const rel = relativePosix(dirname(fromFile), toPath);
  return rel.startsWith(".") ? rel : `./${rel}`;
}
