/**
 * Evaluation-effect detection, in both directions.
 *
 * The false-negative direction is the dangerous one and gets the most cases: a
 * caller looking at an empty result will read it as "moving this module into a
 * barrel changes nothing", and a construct this detector silently walks past
 * would make that reading wrong without anyone noticing. So every construct that
 * counts has a case that fails if the walk stops descending, and every construct
 * that does not count has a case that fails if the walk starts.
 *
 * The false-positive direction matters too, just less: a detector that flags
 * every module is one nobody reads, so the "clean module" case pins that a
 * realistic file comes back empty.
 */

import { describe, expect, test } from "bun:test";

import { evaluationEffects } from "../src/codemod/side-effects.ts";

const MODULE = "/workspace/apps/api/src/service.ts";

function kinds(source: string, path = MODULE): string[] {
  return evaluationEffects(source, path).map((effect) => effect.kind);
}

describe("constructs that run when the module is evaluated", () => {
  test("reports a bindingless import, and locates it by line", () => {
    const source = ['import { register } from "./registry.ts";', 'import "./polyfill.ts";', ""].join("\n");
    expect(evaluationEffects(source, MODULE)).toEqual([{ kind: "side-effect-import", line: 2, text: 'import "./polyfill.ts";' }]);
  });

  test("reports an empty named import, which evaluates its target exactly like a bindingless one", () => {
    expect(kinds('import {} from "./polyfill.ts";\n')).toEqual(["side-effect-import"]);
  });

  test("reports every expression statement, whatever the expression is", () => {
    const source = ["connect();", "registry.count += 1;", "delete registry.stale;", "counter++;", ""].join("\n");
    expect(evaluationEffects(source, MODULE)).toEqual([
      { kind: "expression-statement", line: 1, text: "connect();" },
      { kind: "expression-statement", line: 2, text: "registry.count += 1;" },
      { kind: "expression-statement", line: 3, text: "delete registry.stale;" },
      { kind: "expression-statement", line: 4, text: "counter++;" },
    ]);
  });

  test("reports a top-level await alongside the construct that contains it", () => {
    // Both are true and both matter: the call does work at evaluation, and the
    // await makes every importer of this module wait on a promise. Suppressing
    // either would hide something.
    expect(evaluationEffects("const settings = await load();\n", MODULE)).toEqual([
      { kind: "initializer-call", line: 1, text: "settings = await load()" },
      { kind: "top-level-await", line: 1, text: "await load()" },
    ]);
    expect(kinds("await start();\n")).toEqual(["expression-statement", "top-level-await"]);
  });

  test("reports an initializer whose call is buried, and a tagged template as the call it is", () => {
    const source = [
      "const config = { retries: 3, transport: createTransport() };",
      "const client = new Client(config);",
      "const query = sql`select 1`;",
      "",
    ].join("\n");
    expect(kinds(source)).toEqual(["initializer-call", "initializer-call", "initializer-call"]);
  });

  test("reports every top-level control-flow statement", () => {
    const source = [
      "if (enabled) start();",
      "for (const item of items) register(item);",
      "for (const key in registry) touch(key);",
      "for (let index = 0; index < 3; index += 1) tick();",
      "while (pending()) drain();",
      "do { drain(); } while (pending());",
      "try { start(); } catch { stop(); }",
      "switch (mode) { case 1: start(); }",
      "outer: for (const item of items) register(item);",
      "",
    ].join("\n");
    expect(kinds(source)).toEqual(Array<string>(9).fill("control-flow"));
  });

  test("reports a throw and a bare block, which are neither declarations nor expression statements", () => {
    expect(kinds('if (!process.env.KEY) throw new Error("missing");\n')).toEqual(["control-flow"]);
    expect(kinds('throw new Error("unreachable");\n')).toEqual(["control-flow"]);
    expect(kinds("{ start(); }\n")).toEqual(["control-flow"]);
  });

  test("reports statements inside a non-ambient namespace body, which executes", () => {
    expect(kinds("namespace Legacy {\n  register();\n}\n")).toEqual(["expression-statement"]);
    expect(evaluationEffects("namespace Legacy {\n  register();\n}\n", MODULE)[0]?.line).toBe(2);
  });

  test("reports an evaluated export assignment", () => {
    expect(kinds("export default createThing();\n")).toEqual(["initializer-call"]);
    expect(kinds("export = createThing();\n")).toEqual(["initializer-call"]);
  });

  test("reports `for await` as the top-level await it is, written without the keyword", () => {
    expect(kinds("for await (const chunk of stream) handle(chunk);\n")).toEqual(["control-flow", "top-level-await"]);
  });

  test("reports each offending declarator in a multi-declarator statement, and only those", () => {
    expect(evaluationEffects("const a = load(), b = 2, c = build();\n", MODULE)).toEqual([
      { kind: "initializer-call", line: 1, text: "a = load()" },
      { kind: "initializer-call", line: 1, text: "c = build()" },
    ]);
  });
});

describe("constructs that run later, or not at all", () => {
  test("a call inside a function body, an arrow body, or a class method is not an effect", () => {
    const source = [
      "export function start() {",
      "  connect();",
      "}",
      "export const stop = () => {",
      "  disconnect();",
      "};",
      "export class Session {",
      "  open() {",
      "    connect();",
      "  }",
      "  get status() {",
      "    return probe();",
      "  }",
      "  set status(value: string) {",
      "    apply(value);",
      "  }",
      "  constructor() {",
      "    connect();",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(evaluationEffects(source, MODULE)).toEqual([]);
  });

  test("a default parameter value is not an effect: it runs on call, not on evaluation", () => {
    expect(evaluationEffects("export function start(clock = createClock()) {\n  return clock;\n}\n", MODULE)).toEqual([]);
  });

  test("declarations that only bind names are not effects", () => {
    const source = [
      'import type { Row } from "./rows.ts";',
      'import { register } from "./registry.ts";',
      'export * from "./rows.ts";',
      "export { register };",
      "export default function start() {}",
      "interface Options { retries: number }",
      'type Mode = "fast" | "slow";',
      "enum Level { Low, High }",
      "class Session {}",
      "function stop() {}",
      "declare const injected: string;",
      "export default class {}",
      "",
    ].join("\n");
    expect(evaluationEffects(source, MODULE)).toEqual([]);
  });

  test("literal initializers with no call are not effects", () => {
    const source = [
      'const name = "api";',
      "const retries = 3;",
      'const options = { retries: 3, nested: { mode: "fast" } };',
      'const modes = ["fast", "slow"];',
      "const label = `mode: ${name}`;",
      "const chosen = retries > 2 ? modes[0] : modes[1];",
      "let mutable;",
      "",
    ].join("\n");
    expect(evaluationEffects(source, MODULE)).toEqual([]);
  });
});

describe("the distinctions that make this worth having", () => {
  test("a call in an initializer counts; the same call inside an arrow does not", () => {
    expect(kinds("const x = createThing();\n")).toEqual(["initializer-call"]);
    expect(kinds("const f = () => createThing();\n")).toEqual([]);
    // An immediately-invoked arrow is a call again, and this is the case a
    // naive "does the initializer contain an arrow?" test would get wrong.
    expect(kinds("const y = (() => createThing())();\n")).toEqual(["initializer-call"]);
  });

  test("an instance property initializer does not count; a static one with a call does", () => {
    expect(evaluationEffects("class Session {\n  transport = createTransport();\n}\n", MODULE)).toEqual([]);
    expect(evaluationEffects("class Session {\n  static transport = createTransport();\n}\n", MODULE)).toEqual([
      { kind: "class-definition", line: 2, text: "static transport = createTransport();" },
    ]);
    // A static property with no call initializes a slot on the class object and
    // is not reported: over-approximating on syntax alone would flag every class
    // that holds a constant.
    expect(evaluationEffects("class Session {\n  static limit = 3;\n}\n", MODULE)).toEqual([]);
  });

  test("a static block counts, unconditionally", () => {
    // Static initialization runs when the class definition is evaluated, which
    // for a top-level class is module evaluation. The second case has no call in
    // it at all and is still reported: a static block's body is arbitrary
    // statements, and "it exists but does nothing" is not worth relying on.
    expect(kinds("class Session {\n  static { register(Session); }\n}\n")).toEqual(["class-definition"]);
    expect(kinds("class Session {\n  static { globalThis.session = 1; }\n}\n")).toEqual(["class-definition"]);
  });

  test("class definition time is module evaluation time for the rest of the class too", () => {
    expect(kinds("class Session extends mixin(Base) {}\n")).toEqual(["class-definition"]);
    expect(kinds("@service()\nclass Session {}\n")).toEqual(["class-definition"]);
    expect(kinds("class Session {\n  [key()]() {}\n}\n")).toEqual(["class-definition"]);
    // A class expression is a class definition wherever it is written.
    expect(kinds("const Session = class {\n  static { register(); }\n};\n")).toEqual(["class-definition"]);
  });
});

describe("a module with nothing to report", () => {
  test("a realistic module comes back empty", () => {
    // If this ever fails, the detector has started flagging ordinary code, and
    // an inventory that names every module is one nobody will read.
    const source = [
      'import type { Row } from "./rows.ts";',
      'import { formatRow } from "./format.ts";',
      "",
      "export interface Options {",
      "  readonly retries: number;",
      "}",
      "",
      "export const DEFAULT_OPTIONS: Options = { retries: 3 };",
      "",
      'const SEPARATOR = ", ";',
      "",
      "export class Formatter {",
      "  private readonly rows: Row[] = [];",
      "",
      "  constructor(private readonly options: Options = DEFAULT_OPTIONS) {}",
      "",
      "  add(row: Row): this {",
      "    this.rows.push(row);",
      "    return this;",
      "  }",
      "",
      "  toString(): string {",
      "    return this.rows.map(formatRow).join(SEPARATOR);",
      "  }",
      "}",
      "",
      "export function format(rows: readonly Row[], options = DEFAULT_OPTIONS): string {",
      "  const formatter = new Formatter(options);",
      "  for (const row of rows) formatter.add(row);",
      "  return formatter.toString();",
      "}",
      "",
    ].join("\n");
    expect(evaluationEffects(source, MODULE)).toEqual([]);
  });
});

describe("script kind", () => {
  test("parses .tsx as TSX, so JSX does not become a wall of syntax errors", () => {
    const source = ["export function Panel() {", '  return <div className="panel">{label()}</div>;', "}", ""].join("\n");
    // Parsed as TSX the JSX is a return expression inside a function body, so
    // there is nothing to report.
    expect(evaluationEffects(source, "/workspace/apps/web/src/panel.tsx")).toEqual([]);
    // And effects in a .tsx file are still found: the parse is not the reason
    // the case above is empty.
    expect(kinds(`${source}register(Panel);\n`, "/workspace/apps/web/src/panel.tsx")).toEqual(["expression-statement"]);
  });
});

describe("reported text", () => {
  test("collapses whitespace and truncates, so a long construct stays one line", () => {
    const body = Array.from({ length: 12 }, (_, index) => `  register(handler${index});`).join("\n");
    const effects = evaluationEffects(`if (enabled) {\n${body}\n}\n`, MODULE);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.text).toStartWith("if (enabled) { register(handler0); ");
    expect(effects[0]?.text).toEndWith("...");
    expect(effects[0]?.text.length).toBe(120);
    expect(effects[0]?.text).not.toInclude("\n");
  });
});
