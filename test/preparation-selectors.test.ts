import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { PreparationSelectionError, selectTypeOnlyDeclarations } from "../src/prepare/selectors.ts";
import { analyzeTypeScriptSource } from "../src/symbols/index.ts";
import { hashText } from "../src/util/hash.ts";

const SOURCE_PATH = "apps/example/src/contracts.ts";
const COMPILER_OPTIONS = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true } as const;

function select(input: Omit<Parameters<typeof selectTypeOnlyDeclarations>[0], "compilerOptions">) {
  return selectTypeOnlyDeclarations({ ...input, compilerOptions: COMPILER_OPTIONS });
}

describe("type-only preparation selectors", () => {
  test("selects exact declaration and trivia spans, closure imports, and compatibility exports", () => {
    const sourceText = [
      'import type { External as Imported } from "./external.ts";',
      "",
      "/** Public contract. */",
      "export interface Public { local: Local; external: Imported }",
      "interface Local { id: string }",
      "",
    ].join("\n");
    const result = select({ sourcePath: SOURCE_PATH, sourceText, names: ["Public"] });
    const publicDeclaration = result.declarations.find((item) => item.name === "Public");
    const localDeclaration = result.declarations.find((item) => item.name === "Local");
    if (!publicDeclaration || !localDeclaration) throw new Error("expected closure declarations");

    const publicStart = sourceText.indexOf("export interface Public");
    const triviaStart = sourceText.indexOf("\n\n");
    expect(publicDeclaration.declaration).toEqual({
      start: publicStart,
      end: publicStart + "export interface Public { local: Local; external: Imported }".length,
      hash: hashText("export interface Public { local: Local; external: Imported }"),
    });
    expect(publicDeclaration.extraction.start).toBe(triviaStart);
    expect(publicDeclaration.extraction.hash).toBe(hashText(sourceText.slice(triviaStart, publicDeclaration.declaration.end)));
    expect(publicDeclaration.leadingTriviaHash).toBe(hashText(sourceText.slice(triviaStart, publicStart)));
    expect(localDeclaration.extraction.hash).toBe(hashText(sourceText.slice(localDeclaration.extraction.start, localDeclaration.extraction.end)));
    expect(result.requestedGroupIds).toEqual([publicDeclaration.groupId]);
    expect(result.closureGroupIds).toEqual([localDeclaration.groupId, publicDeclaration.groupId].toSorted());
    expect(result.imports).toEqual([
      { localName: "Imported", importedName: "External", moduleSpecifier: "./external.ts", kind: "named", originallyTypeOnly: true, requiredAs: "type" },
    ]);
    expect(result.compatibilitySurface).toEqual([{ name: "Public", groupId: publicDeclaration.groupId, reexportAs: "type" }]);
    expect(result.compatibilitySurface.some((item) => item.name === "Local")).toBe(false);
    expect(publicDeclaration.originallyExported).toBe(true);
    expect(localDeclaration.originallyExported).toBe(false);
  });

  test("selects every member of an interface merge from one group selector", () => {
    const sourceText = "export interface Merge { left: string }\nexport interface Merge { right: number }\n";
    const result = select({ sourcePath: SOURCE_PATH, sourceText, names: ["Merge"] });

    expect(result.declarations.map((item) => item.name)).toEqual(["Merge", "Merge"]);
    expect(new Set(result.declarations.map((item) => item.groupId)).size).toBe(1);
    expect(result.compatibilitySurface.map((item) => item.name)).toEqual(["Merge"]);
  });

  test("selects declared interfaces and type aliases without widening to ambient values", () => {
    const sourceText = [
      "export declare interface AmbientShape { value: AmbientName }",
      "export declare type AmbientName = string;",
      "export declare class AmbientRuntime {}",
      "",
    ].join("\n");
    const result = select({ sourcePath: SOURCE_PATH, sourceText, names: ["AmbientShape"] });

    expect(result.declarations.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "AmbientShape", kind: "interface" },
      { name: "AmbientName", kind: "type-alias" },
    ]);
    expect(result.declarations.every((declaration) => sourceText.slice(declaration.declaration.start, declaration.declaration.end).includes("declare"))).toBe(
      true,
    );
    expect(() => select({ sourcePath: SOURCE_PATH, sourceText, names: ["AmbientRuntime"] })).toThrow("occupies type and/or value space");
    expect(() => select({ sourcePath: SOURCE_PATH, sourceText: "declare interface GlobalShape { value: string }\n", names: ["GlobalShape"] })).toThrow(
      "may have script-global visibility",
    );
  });

  test("uses symbol identity, not text, for a type parameter shadowing an import", () => {
    const sourceText = 'import type { T } from "./external.ts";\nexport type Wrapped<T> = { value: T };\n';
    const result = select({ sourcePath: SOURCE_PATH, sourceText, names: ["Wrapped"] });

    expect(result.imports).toEqual([]);
  });

  test("refuses missing and duplicate selectors", () => {
    const sourceText = "export interface Present { value: string }\n";
    const graph = analyzeTypeScriptSource({ sourcePath: SOURCE_PATH, sourceText });
    const present = graph.groups[0];
    if (!present) throw new Error("expected declaration group");

    expect(() => select({ sourcePath: SOURCE_PATH, sourceText, names: ["Missing"] })).toThrow(PreparationSelectionError);
    expect(() => select({ sourcePath: SOURCE_PATH, sourceText, groupIds: [present.id], names: ["Present"] })).toThrow("duplicate declaration group selector");
  });

  test("refuses default exports, runtime/type merges, unique symbols, and value queries", () => {
    expectRefusal("export default interface Defaulted { value: string }\n", "Defaulted", "default export");
    expectRefusal('export interface Token { value: string }\nexport const Token = { value: "token" };\n', "Token", "occupies type and/or value space");
    expectRefusal("export interface Identity { readonly value: unique symbol }\n", "Identity", "unsafe unique-symbol identity");
    expectRefusal('import { runtime } from "./runtime.ts";\nexport type Query = typeof runtime;\n', "Query", "unsafe unique-symbol identity");
  });

  test("records exact donor-relative inline import type literals for proven relocation", () => {
    const relative = 'export type Relative = import("./models.ts").Model;\n';
    const selected = select({ sourcePath: SOURCE_PATH, sourceText: relative, names: ["Relative"] });
    const literal = '"./models.ts"';
    const start = relative.indexOf(literal);
    expect(selected.relativeInlineImportTypes).toEqual([
      { originalSpecifier: "./models.ts", start, end: start + literal.length, sourceHash: hashText(literal) },
    ]);

    const packageType = 'export type Package = import("external-package").Model;\n';
    const packageSelection = select({ sourcePath: SOURCE_PATH, sourceText: packageType, names: ["Package"] });
    expect(packageSelection.declarations).toHaveLength(1);
    expect(packageSelection.relativeInlineImportTypes).toEqual([]);
  });
});

function expectRefusal(sourceText: string, name: string, message: string): void {
  expect(() => select({ sourcePath: SOURCE_PATH, sourceText, names: [name] })).toThrow(message);
}
