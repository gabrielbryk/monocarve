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

/** `resolve(…)` or `path.resolve(…)` — the callee name alone, deliberately unqualified. */
function isResolveCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "resolve";
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "resolve";
}

function literalTextOf(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/**
 * Names of local `const NAME = (param) => …` helpers whose body calls
 * `resolve(import.meta.dir, param)` with that same parameter — the
 * `const read = (path) => readFileSync(resolve(import.meta.dir, path), "utf8")`
 * idiom. Single-parameter only, and matched by parameter name alone: this is a
 * lexical pattern match, not dataflow, so a shadowing inner function with an
 * unrelated parameter of the same name is not disambiguated.
 */
function resolveHelperNames(root: ts.Node): ReadonlySet<string> {
  const helpers = new Set<string>();
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
        helpers.add(node.name.text);
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
  const helpers = resolveHelperNames(file);
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
        if (first && second && isImportMetaDir(first)) record(second);
      } else if (ts.isIdentifier(node.expression) && node.arguments.length === 1 && helpers.has(node.expression.text)) {
        record(node.arguments[0]!);
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
