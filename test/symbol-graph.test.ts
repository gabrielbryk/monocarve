import { describe, expect, test } from "bun:test";

import {
  analyzeTypeScriptSource,
  SymbolAnalysisError,
  type DeclarationGroup,
  type SymbolGraph,
} from "../src/symbols/index.ts";
import { stableStringify } from "../src/util/hash.ts";

function analyze(sourceText: string, sourcePath = "apps/service/src/large-module.ts"): SymbolGraph {
  return analyzeTypeScriptSource({ sourcePath, sourceText });
}

function byName<T extends { readonly name: string }>(items: readonly T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`missing ${name}`);
  return item;
}

function groupName(graph: SymbolGraph, id: string): string {
  return graph.groups.find((group) => group.id === id)?.name ?? "<missing>";
}

function edge(graph: SymbolGraph, source: string, target: string) {
  const found = graph.edges.find(
    (candidate) => groupName(graph, candidate.source) === source && groupName(graph, candidate.target) === target,
  );
  if (!found) throw new Error(`missing edge ${source} -> ${target}`);
  return found;
}

describe("TypeScript symbol graph", () => {
  test("records stable physical declaration identity and type/value space", () => {
    const graph = analyze(`
export interface Shape { area: number }
export type ShapeName = string;
export class Widget implements Shape { area = 1 }
export enum Mode { On, Off }
export function render(widget: Widget): ShapeName { return String(widget.area) }
const origin = 0;
export { origin };
`);

    expect(graph.declarations.map(({ name, kind, space, exported }) => ({ name, kind, space, exported }))).toEqual([
      { name: "Shape", kind: "interface", space: "type", exported: true },
      { name: "ShapeName", kind: "type-alias", space: "type", exported: true },
      { name: "Widget", kind: "class", space: "both", exported: true },
      { name: "Mode", kind: "enum", space: "both", exported: true },
      { name: "render", kind: "function", space: "value", exported: true },
      { name: "origin", kind: "variable", space: "value", exported: true },
    ]);
    for (const declaration of graph.declarations) {
      expect(declaration.id).toMatch(/^[0-9a-f]{64}$/);
      expect(declaration.span.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(declaration.span.end).toBeGreaterThan(declaration.span.start);
      expect(declaration.sourcePath).toBe("apps/service/src/large-module.ts");
    }
  });

  test("groups overloads and legal type/value merges without erasing physical distinction", () => {
    const graph = analyze(`
export interface Token { value: string }
export const Token = { value: "token" };
export function parse(value: string): string;
export function parse(value: number): number;
export function parse(value: string | number): string | number { return value }
`);
    const token = byName(graph.groups, "Token");
    const parse = byName(graph.groups, "parse");

    expect(token.space).toBe("both");
    expect(token.declarationIds).toHaveLength(2);
    expect(
      graph.declarations.filter((item) => token.declarationIds.includes(item.id)).map((item) => item.space),
    ).toEqual(["type", "value"]);
    expect(parse.space).toBe("value");
    expect(parse.declarationIds).toHaveLength(3);
  });

  test("distinguishes type references from runtime value references", () => {
    const graph = analyze(`
interface Payload { id: string }
const seed = 1;
type Wrapped = { payload: Payload; seed: typeof seed };
function make(payload: Payload): Wrapped { return { payload, seed } }
class Service { build(): Wrapped { return make({ id: String(seed) }) } }
`);

    expect(edge(graph, "Wrapped", "Payload").space).toBe("type");
    expect(edge(graph, "Wrapped", "seed").space).toBe("value");
    expect(edge(graph, "make", "Payload").space).toBe("type");
    expect(edge(graph, "make", "Wrapped").space).toBe("type");
    expect(edge(graph, "make", "seed").space).toBe("value");
    expect(edge(graph, "Service", "Wrapped").space).toBe("type");
    expect(edge(graph, "Service", "make").space).toBe("value");
    expect(edge(graph, "Service", "seed").space).toBe("value");

    const reference = edge(graph, "Service", "make").references[0];
    expect(reference?.sourceDeclarationId).toBe(byName(graph.declarations, "Service").id);
    expect(reference?.span.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("condenses mutually recursive declarations into deterministic SCCs", () => {
    const graph = analyze(`
function alpha(value: number): number { return value <= 0 ? 0 : beta(value - 1) }
function beta(value: number): number { return value <= 0 ? 0 : alpha(value - 1) }
function independent(): number { return 1 }
function recursive(): number { return recursive() }
`);
    const namedComponents = graph.components.map((component) => ({
      names: component.groupIds.map((id) => groupName(graph, id)).sort(),
      cyclic: component.cyclic,
    }));

    expect(namedComponents).toContainEqual({ names: ["alpha", "beta"], cyclic: true });
    expect(namedComponents).toContainEqual({ names: ["independent"], cyclic: false });
    expect(namedComponents).toContainEqual({ names: ["recursive"], cyclic: true });
  });

  test("is byte-deterministic and normalizes the stable display path", () => {
    const input = {
      sourcePath: "apps\\service\\src\\module.ts",
      sourceText: "const Zebra = 1; const alpha = Zebra; export { alpha };\n",
    };
    const first = analyzeTypeScriptSource(input);
    const second = analyzeTypeScriptSource(input);

    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(first.sourcePath).toBe("apps/service/src/module.ts");
    expect(first.groups.map((group) => group.name)).toEqual(["Zebra", "alpha"]);
    expect(first.edges.map((item) => [groupName(first, item.source), groupName(first, item.target)])).toEqual([
      ["alpha", "Zebra"],
    ]);
  });

  test("span identity changes when declaration bytes change", () => {
    const before = analyze("const stable = 1;\nfunction calculate() { return stable; }\n");
    const after = analyze("const stable = 1;\nfunction calculate() { return stable + 1; }\n");

    expect(byName(before.declarations, "stable").span.hash).toBe(byName(after.declarations, "stable").span.hash);
    expect(byName(before.declarations, "calculate").span.hash).not.toBe(
      byName(after.declarations, "calculate").span.hash,
    );
    expect(byName(before.declarations, "calculate").id).not.toBe(byName(after.declarations, "calculate").id);
  });

  test("does not confuse unresolved external modules with ambiguous local bindings", () => {
    const graph = analyze(`
import type { Remote } from "@vendor/contracts";
interface Local { remote: Remote }
const value: Local | undefined = undefined;
`);
    expect(graph.groups.map((group) => group.name)).toEqual(["Local", "value"]);
    expect(edge(graph, "value", "Local").space).toBe("type");
    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({ phase: "semantic", code: 2307, category: "error" }),
    );
  });

  test("parses TSX using the source path instead of treating JSX as ambiguous TypeScript", () => {
    const graph = analyzeTypeScriptSource({
      sourcePath: "apps/web/src/card.tsx",
      sourceText: "interface Props { label: string }\nexport function Card(props: Props) { return <div>{props.label}</div> }\n",
    });
    expect(graph.groups.map(({ name, space }) => ({ name, space }))).toEqual([
      { name: "Card", space: "value" },
      { name: "Props", space: "type" },
    ]);
    expect(edge(graph, "Card", "Props").space).toBe("type");
  });

  test("refuses syntax and semantic ambiguity instead of returning a partial graph", () => {
    expect(() => analyze("const broken = ;")).toThrow(SymbolAnalysisError);
    try {
      analyze("const duplicate = 1; const duplicate = 2;");
      throw new Error("expected duplicate declaration to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(SymbolAnalysisError);
      expect((error as SymbolAnalysisError).diagnostics.some((diagnostic) => diagnostic.code === 2451)).toBe(true);
    }
    expect(() => analyze('declare module "third-party" { export const value: number }')).toThrow(
      "string-literal module declarations",
    );
    expect(() => analyzeTypeScriptSource({ sourcePath: "../outside.ts", sourceText: "const value = 1" })).toThrow(
      "may not leave the repository",
    );
  });

  test("keeps group IDs independent of map iteration and exposes sorted declaration IDs", () => {
    const graph = analyze(`
function combine(value: string): string;
function combine(value: number): number;
function combine(value: string | number) { return value }
`);
    const group: DeclarationGroup = byName(graph.groups, "combine");
    const physicalIds = graph.declarations.filter((item) => item.name === "combine").map((item) => item.id);
    expect(group.declarationIds).toEqual(physicalIds);
  });
});
