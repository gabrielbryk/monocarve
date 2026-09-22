import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { classifyTypeOnlyExtraction, type TypeOnlyExtractionRefusalCode } from "../src/seams/safety.ts";
import { analyzeTypeScriptSource, type SymbolGraph } from "../src/symbols/index.ts";

function analyze(sourceText: string): SymbolGraph {
  return analyzeTypeScriptSource({ sourcePath: "apps/service/src/definitions.ts", sourceText });
}

function group(graph: SymbolGraph, name: string) {
  const result = graph.groups.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`missing declaration group ${name}`);
  return result;
}

function refusalCodes(sourceText: string, name: string, selectedDeclarationIds?: readonly string[]): readonly TypeOnlyExtractionRefusalCode[] {
  const graph = analyze(sourceText);
  const candidate = group(graph, name);
  return classifyTypeOnlyExtraction({
    sourceText,
    graph,
    groupId: candidate.id,
    ...(selectedDeclarationIds === undefined ? {} : { selectedDeclarationIds }),
  }).evidence.map((evidence) => evidence.code);
}

describe("type-only seam safety", () => {
  test("accepts a complete interface merge and a type alias", () => {
    const sourceText = "export interface Shape { width: number }\nexport interface Shape { height: number }\nexport type ShapeName = string;\n";
    const graph = analyze(sourceText);
    const shape = group(graph, "Shape");
    const result = classifyTypeOnlyExtraction({ sourceText, graph, groupId: shape.id });

    expect(result).toEqual({ groupId: shape.id, declarationIds: shape.declarationIds, eligible: true, evidence: [] });
    const alias = group(graph, "ShapeName");
    expect(classifyTypeOnlyExtraction({ sourceText, graph, groupId: alias.id }).eligible).toBe(true);
  });

  test("accepts ambient modifiers only on type-erased declaration forms", () => {
    const sourceText = "export declare interface AmbientShape { width: number }\nexport declare type AmbientName = string;\n";
    const graph = analyze(sourceText);

    for (const name of ["AmbientShape", "AmbientName"]) {
      const candidate = group(graph, name);
      expect(classifyTypeOnlyExtraction({ sourceText, graph, groupId: candidate.id })).toEqual({
        groupId: candidate.id,
        declarationIds: candidate.declarationIds,
        eligible: true,
        evidence: [],
      });
    }
    expect(tsOutput(sourceText)).toBe("export {};\n");
  });

  test("refuses a non-exported ambient type whose script-global visibility cannot be preserved", () => {
    expect(refusalCodes("declare interface GlobalShape { width: number }\n", "GlobalShape")).toContain("ambient-declaration");
    expect(refusalCodes("declare type GlobalName = string;\n", "GlobalName")).toContain("ambient-declaration");
  });

  test("refuses runtime-emitting declarations", () => {
    expect(refusalCodes("export enum Mode { Active }\n", "Mode")).toContain("enum-declaration");
    expect(refusalCodes("export namespace Runtime { export const state = 1 }\n", "Runtime")).toContain("runtime-namespace");
    expect(refusalCodes("export default interface Settings { enabled: boolean }\n", "Settings")).toContain("default-export");
  });

  test("refuses ambient module augmentation", () => {
    const sourceText = "declare module Extension { interface Options { enabled: boolean } }\n";
    expect(refusalCodes(sourceText, "Extension")).toContain("module-augmentation");
  });

  test("refuses ambient declarations which bind values", () => {
    expect(refusalCodes("export declare class AmbientClass {}\n", "AmbientClass")).toContain("ambient-declaration");
    expect(refusalCodes("export declare function ambientFunction(): void;\n", "ambientFunction")).toContain("ambient-declaration");
    expect(refusalCodes("export declare const ambientValue: string;\n", "ambientValue")).toContain("non-type-declaration");
  });

  test("refuses a type/value merge", () => {
    const sourceText = 'export interface Token { value: string }\nexport const Token = { value: "token" };\n';
    const codes = refusalCodes(sourceText, "Token");
    expect(codes).toContain("type-value-mixed-group");
    expect(codes).toContain("non-type-declaration");
  });

  test("refuses partial interface merges and function overload groups", () => {
    const interfaceSource = "interface Merge { left: string }\ninterface Merge { right: number }\n";
    const interfaceGraph = analyze(interfaceSource);
    const merged = group(interfaceGraph, "Merge");
    const onlyOne = merged.declarationIds[0];
    if (!onlyOne) throw new Error("expected an interface merge member");
    expect(refusalCodes(interfaceSource, "Merge", [onlyOne])).toContain("incomplete-declaration-group");

    const overloadSource =
      "function parse(input: string): string;\nfunction parse(input: number): number;\nfunction parse(input: string | number) { return input }\n";
    const overloadGraph = analyze(overloadSource);
    const overload = group(overloadGraph, "parse");
    const partial = overload.declarationIds.slice(0, 1);
    const result = classifyTypeOnlyExtraction({ sourceText: overloadSource, graph: overloadGraph, groupId: overload.id, selectedDeclarationIds: partial });
    expect(result.evidence.map((evidence) => evidence.code)).toEqual(expect.arrayContaining(["incomplete-declaration-group", "function-overload-group"]));
  });

  test("refuses stale graph source and stale declaration spans", () => {
    const sourceText = "interface Stable { value: string }\n";
    const graph = analyze(sourceText);
    const stable = group(graph, "Stable");
    expect(
      classifyTypeOnlyExtraction({ sourceText: `// changed\n${sourceText}`, graph, groupId: stable.id }).evidence.map((evidence) => evidence.code),
    ).toContain("graph-source-mismatch");

    const declaration = graph.declarations[0];
    if (!declaration) throw new Error("expected stable declaration");
    const staleGraph: SymbolGraph = { ...graph, declarations: [{ ...declaration, span: { ...declaration.span, end: declaration.span.end - 1 } }] };
    expect(classifyTypeOnlyExtraction({ sourceText, graph: staleGraph, groupId: stable.id }).evidence.map((evidence) => evidence.code)).toContain(
      "declaration-span-mismatch",
    );
  });
});

function tsOutput(sourceText: string): string {
  return analyzeTypeScriptOutput(sourceText).replace(/\r\n/g, "\n");
}

function analyzeTypeScriptOutput(sourceText: string): string {
  return ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
}
