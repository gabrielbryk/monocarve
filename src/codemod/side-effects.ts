/**
 * What a module does when it is *evaluated*, as opposed to when something in it
 * is called.
 *
 * Why this exists: the scaffolded package entrypoint `export *`s every moved
 * production file, and every consumer is repointed at the package name — the
 * barrel. A consumer that used to deep-import one module now imports the barrel,
 * and ES module semantics evaluate every module the barrel re-exports, in barrel
 * order, on first import. So work that a moved module does at evaluation time
 * starts happening for consumers that never named that module, in an order the
 * plan chose. None of the existing evidence can see this: byte fidelity compares
 * hashes, the replay proof re-derives bytes, the boundary rules check exported
 * names, and the dynamic-import delta tracks `import()`. All four are satisfied
 * by a move that changes when a module's top-level `connect()` runs.
 *
 * ## What this is, exactly
 *
 * A **risk inventory, not a proof of impurity.** It over-approximates on
 * purpose: `const id = randomUUID()` and `const label = String(1)` are both a
 * call at module top level, and it reports both. A module that comes back with
 * effects has not been shown to do anything observable — a human still has to
 * look at it.
 *
 * The direction that has to hold is the other one. For the constructs named
 * below it does not under-report, because that is the only property a caller
 * could lean on. Per the agent contract's proof discipline: an empty result is
 * *not* "this module has no behaviour change". It means "none of the syntactic
 * constructs this function knows about appear at this module's top level" —
 * which is a much smaller claim, and anything downstream that reads it as the
 * larger one is trusting something this cannot deliver. The known gaps are
 * listed at the bottom of this comment, and they are not exotic.
 *
 * ## The rule
 *
 * Top level means: evaluated when the module is evaluated. Function bodies,
 * arrow bodies, method bodies, accessor bodies, constructor bodies and default
 * parameter values run when they are called, so nothing inside them counts.
 *
 * A top-level `class` is the case worth stating outright, because it cuts both
 * ways and the choice is deliberate: **for a top-level class, class-definition
 * time is module-evaluation time.** So a `static` block and a `static` property
 * initializer containing a call *do* count — static initialization runs the
 * moment the class definition is evaluated. Applying the same rule consistently,
 * a class decorator, a member decorator, a computed member name, and a call in
 * the `extends` clause also count: all four run at definition. An *instance*
 * property initializer does not count, however much work it does, because it
 * runs at construction. A static block counts unconditionally rather than only
 * when it contains a call: its body is arbitrary statements, and there is no
 * reading of "this block exists but does nothing at definition time" worth
 * relying on.
 *
 * ## What it does not attempt
 *
 * - **It does not follow imports.** A module whose own top level is spotless can
 *   import one that is not; the barrel's whole closure is the caller's question,
 *   not this function's. By the same token `import x from "./m"` and
 *   `export * from "./m"` do evaluate `m` and are not reported here — only a
 *   *bindingless* import is, because there evaluation is the only reason the
 *   line exists.
 *
 *   That question now has an answer, and it lives elsewhere:
 *   `../plan/evaluation-closure.ts` walks the evaluation-causing edges out of
 *   the moved set and points this function at every first-party module it
 *   reaches, so `manifest.evaluationEffects` covers the closure rather than the
 *   moved files. Two limits survive that and are not this module's to fix.
 *   **Order is still unmodelled**: the inventory is a *set*, and barrel
 *   evaluation order is exactly what matters when two modules' effects interact
 *   — a module reading a global another module set, a registry read before it is
 *   populated. And the closure stops at `node_modules`: a third-party package is
 *   recorded by name and by its own `sideEffects` claim, never parsed.
 * - **It does no purity analysis.** It does not know, and cannot know from one
 *   file, whether a called function is pure. Every call at top level is reported
 *   and most of them will be harmless.
 * - **It does not model the type system**, resolve anything, or read the
 *   filesystem. One file, one parse.
 *
 * Constructs it knowingly misses, on the record before anyone builds on it:
 * a property access that triggers a getter (`const a = config.value`), an object
 * spread that does the same (`const a = { ...source }`), a top-level JSX literal
 * (a call after transform, not a call in the source), an `enum` member with a
 * computed initializer, `import x = require("y")` (evaluates the target but has
 * bindings), a top-level `await using` (reported as `initializer-call`, not as
 * `top-level-await`), and anything the parser cannot see at all — `eval`,
 * emitted JavaScript, or a module this tool never reads.
 */

import ts from "typescript";

export type EvaluationEffectKind =
  | "side-effect-import"
  | "expression-statement"
  | "top-level-await"
  | "initializer-call"
  | "control-flow"
  | "class-definition";

export interface EvaluationEffect {
  readonly kind: EvaluationEffectKind;
  /** 1-based line, for a message a human can act on. */
  readonly line: number;
  /** The source text of the offending construct, whitespace collapsed, truncated. */
  readonly text: string;
}

type Emit = (kind: EvaluationEffectKind, node: ts.Node) => void;

/**
 * Long enough to recognise the construct, short enough for a one-line message.
 * A fact about this tool's output, not about any workspace.
 */
const MAX_EXCERPT = 120;

/**
 * Statements that execute where they stand. `throw`, a bare block and
 * `debugger` are here for the same reason as `if`: they are statements, they are
 * not declarations, and they run — the union's name is the closest honest label
 * rather than a claim that each one branches.
 */
const CONTROL_FLOW = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.DebuggerStatement,
]);

/**
 * Mirrors `scriptKind` in `./imports.ts`. It is duplicated rather than shared
 * because it is two lines, but the two must agree: a `.tsx` file parsed as TS
 * turns every JSX literal into a cascade of syntax errors, and a source file
 * full of error nodes silently reports fewer effects than it has.
 */
function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function excerpt(file: ts.SourceFile, node: ts.Node): string {
  // Collapsing whitespace makes a multi-line `if` fit on one line. It also
  // rewrites the inside of string literals, which is fine for something only
  // ever shown to a human and never compared or hashed.
  const text = node.getText(file).replace(/\s+/gu, " ").trim();
  return text.length <= MAX_EXCERPT ? text : `${text.slice(0, MAX_EXCERPT - 3)}...`;
}

function modifiers(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiers(node).some((modifier) => modifier.kind === kind);
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

/**
 * Positions the generic walk must not descend into, because nothing inside them
 * runs when the module is evaluated: anything function-like (its body and its
 * parameter defaults), any type, and a namespace body — namespaces are walked
 * through the statement path instead, so descending here would double-report.
 */
function deferred(node: ts.Node): boolean {
  return (
    ts.isFunctionLike(node) ||
    ts.isTypeNode(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node)
  );
}

/**
 * A tagged template is a call: `` styled.div`…` `` invokes `styled.div` at
 * evaluation, which is exactly the registration-at-import-time pattern this
 * detector exists to notice.
 */
function isEvaluatedCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node);
}

/** The sub-expressions of a class that evaluate when its definition does. */
function definitionTimeParts(node: ts.ClassLikeDeclaration): ts.Node[] {
  const parts: ts.Node[] = decoratorsOf(node).map((decorator) => decorator.expression);
  for (const clause of node.heritageClauses ?? []) {
    for (const type of clause.types) parts.push(type.expression);
  }
  for (const member of node.members) {
    for (const decorator of decoratorsOf(member)) parts.push(decorator.expression);
    if (member.name && ts.isComputedPropertyName(member.name)) parts.push(member.name.expression);
    if (ts.isPropertyDeclaration(member) && hasModifier(member, ts.SyntaxKind.StaticKeyword) && member.initializer) {
      parts.push(member.initializer);
    }
  }
  return parts;
}

/**
 * Whether evaluating `node` reaches a call. Stops at every deferred position, so
 * `() => createThing()` is not a call and `(() => createThing())()` is.
 */
function containsEvaluatedCall(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isClassLike(current)) {
      found =
        current.members.some(ts.isClassStaticBlockDeclaration) ||
        definitionTimeParts(current).some((part) => containsEvaluatedCall(part));
      return;
    }
    if (deferred(current)) return;
    if (isEvaluatedCall(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/**
 * Awaits that suspend module evaluation itself. `for await` is included because
 * it is a top-level await written without the keyword in expression position.
 */
function evaluatedAwaits(node: ts.Node): ts.Node[] {
  const awaits: ts.Node[] = [];
  const visit = (current: ts.Node): void => {
    // A class body cannot contain an await that runs at definition time.
    if (deferred(current) || ts.isClassLike(current)) return;
    if (ts.isAwaitExpression(current)) {
      awaits.push(current);
      return;
    }
    if (ts.isForOfStatement(current) && current.awaitModifier) awaits.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return awaits;
}

/**
 * `import "x"` — no bindings, so evaluating `x` is the only thing the line does.
 * `import {} from "x"` is the same statement with emptier syntax and is treated
 * the same. A type-only import is erased and does not evaluate anything.
 */
function isBindinglessImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly || clause.name) return false;
  const bindings = clause.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length === 0;
}

function classDefinitionEffects(node: ts.ClassLikeDeclaration, record: Emit): void {
  for (const decorator of decoratorsOf(node)) {
    if (containsEvaluatedCall(decorator.expression)) record("class-definition", decorator);
  }
  for (const clause of node.heritageClauses ?? []) {
    for (const type of clause.types) {
      if (containsEvaluatedCall(type.expression)) record("class-definition", type);
    }
  }
  for (const member of node.members) {
    for (const decorator of decoratorsOf(member)) {
      if (containsEvaluatedCall(decorator.expression)) record("class-definition", decorator);
    }
    if (member.name && ts.isComputedPropertyName(member.name) && containsEvaluatedCall(member.name.expression)) {
      record("class-definition", member.name);
    }
    if (ts.isClassStaticBlockDeclaration(member)) {
      record("class-definition", member);
    } else if (
      ts.isPropertyDeclaration(member) &&
      hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
      member.initializer &&
      containsEvaluatedCall(member.initializer)
    ) {
      record("class-definition", member);
    }
  }
}

/**
 * Every construct in `source` that does work when the module is evaluated, in
 * source order.
 *
 * The kinds are not mutually exclusive: one construct can appear under more than
 * one, because they are independent properties. `const x = await load()` is both
 * an `initializer-call` (it calls at evaluation) and a `top-level-await` (it
 * makes every importer of this module wait on a promise), and suppressing either
 * would hide something true.
 *
 * `path` decides nothing but the script kind — this reads no files.
 */
export function evaluationEffects(source: string, path: string): EvaluationEffect[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const found: { readonly start: number; readonly effect: EvaluationEffect }[] = [];

  const record: Emit = (kind, node) => {
    const start = node.getStart(file);
    found.push({
      start,
      effect: { kind, line: file.getLineAndCharacterOfPosition(start).line + 1, text: excerpt(file, node) },
    });
  };

  const classify = (statement: ts.Statement): void => {
    if (ts.isImportDeclaration(statement)) {
      if (isBindinglessImport(statement)) record("side-effect-import", statement);
      return;
    }
    // Declarations that bind names without running anything, plus the export
    // forms that only re-point a name. `import x = require("y")` is here with a
    // known cost: it does evaluate its target, and it is not reported.
    if (
      ts.isExportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      return;
    }
    if (ts.isModuleDeclaration(statement)) {
      // A non-ambient `namespace` body executes at module evaluation, so its
      // statements are top level for this purpose.
      if (statement.body && ts.isModuleBlock(statement.body)) statement.body.statements.forEach(visit);
      return;
    }
    if (ts.isClassDeclaration(statement)) {
      classDefinitionEffects(statement, record);
      return;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (!initializer) continue;
        // `const A = class { static … }` is a class definition wherever it is
        // written; reporting the member is more use than reporting the whole
        // declarator.
        if (ts.isClassExpression(initializer)) classDefinitionEffects(initializer, record);
        else if (containsEvaluatedCall(initializer)) record("initializer-call", declaration);
      }
      return;
    }
    if (ts.isExportAssignment(statement)) {
      // `export default createThing()` and `export = createThing()` evaluate.
      // `export default function f() {}` and `export default class {}` do not
      // reach here — the parser makes those declarations.
      if (ts.isClassExpression(statement.expression)) classDefinitionEffects(statement.expression, record);
      else if (containsEvaluatedCall(statement.expression)) record("initializer-call", statement);
      return;
    }
    if (ts.isExpressionStatement(statement)) {
      record("expression-statement", statement);
      return;
    }
    if (CONTROL_FLOW.has(statement.kind)) {
      // Deliberately not descended into: the module is already flagged, and one
      // effect per top-level construct keeps the report readable.
      record("control-flow", statement);
    }
  };

  const visit = (statement: ts.Statement): void => {
    // `declare` is ambient: it describes, it does not run.
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return;
    classify(statement);
    for (const node of evaluatedAwaits(statement)) record("top-level-await", node);
  };

  for (const statement of file.statements) visit(statement);

  // Sort is stable, so two effects at the same offset keep the order they were
  // recorded in — the construct first, then the await inside it.
  return found.sort((left, right) => left.start - right.start).map((entry) => entry.effect);
}

/**
 * The distinct kinds at a module's top level, deduped and sorted.
 *
 * Line numbers and excerpts are for a human reading one file; a *declaration*
 * that travels in a plan wants the smallest thing that is still checkable, and
 * a sorted set of kinds is stable under any edit that does not change what the
 * module does at evaluation. Sorted explicitly because callers serialize it.
 */
export function evaluationEffectKinds(source: string, path: string): EvaluationEffectKind[] {
  return [...new Set(evaluationEffects(source, path).map((effect) => effect.kind))].sort();
}
