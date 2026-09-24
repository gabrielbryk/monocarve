import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { PreparationReplayError, renderTypeOnlyExtraction, type CheckerProvenTypeImport, type TypeOnlyExtractionSpan } from "../src/prepare/replay.ts";
import { hashText } from "../src/util/hash.ts";

const baseline = [
  'import type { Remote } from "./remote.ts";',
  "",
  "/** A documented public shape. */",
  "export interface Item { remote: Remote; name: string }",
  "",
  "/** A label derived from the shape. */",
  'export type ItemLabel = Item["name"];',
  "",
  "export const kept: Item | null = null;",
  "",
].join("\n");

function span(name: string, kind: TypeOnlyExtractionSpan["kind"]): TypeOnlyExtractionSpan {
  const marker = name === "Item" ? "/** A documented" : "/** A label";
  const start = baseline.indexOf(marker);
  const end = name === "Item" ? baseline.indexOf("\n\n/** A label", start) : baseline.indexOf("\n\nexport const", start);
  const text = baseline.slice(start, end);
  return { start, end, hash: hashText(text), name, kind, originallyExported: true };
}

function proven(moduleSpecifier: string, importedName: string, localName = importedName): CheckerProvenTypeImport {
  return { moduleSpecifier, importedName, localName, kind: "named", originallyTypeOnly: true, requiredAs: "type", proofBaselineHash: hashText(baseline) };
}

function input(selected: readonly TypeOnlyExtractionSpan[] = [span("Item", "interface"), span("ItemLabel", "type-alias")]) {
  const reExportNames = [...new Set(selected.filter((item) => item.originallyExported).map((item) => item.name))].toSorted();
  return {
    baselineText: baseline,
    baselineHash: hashText(baseline),
    selected,
    targetPath: "packages/contracts/src/item.ts",
    moduleSpecifier: "./item.ts",
    targetImports: [proven("./remote.ts", "Remote")],
    compatibility: { reExportNames, donorImports: [proven("./item.ts", "Item")] },
  } as const;
}

describe("type-only preparation replay", () => {
  test("rewrites relative inline import types only with exact baseline proof", () => {
    const source = 'export type Model = import("./models.ts").Model;\n';
    const sourceHash = hashText(source);
    const literal = '"./models.ts"';
    const literalStart = source.indexOf(literal);
    const selected = [
      { start: 0, end: source.length - 1, hash: hashText(source.slice(0, -1)), name: "Model", kind: "type-alias" as const, originallyExported: true },
    ];
    const proof = {
      originalSpecifier: "./models.ts",
      targetSpecifier: "../../../apps/example/src/models.ts",
      start: literalStart,
      end: literalStart + literal.length,
      sourceHash: hashText(literal),
      proofBaselineHash: sourceHash,
    };
    const result = renderTypeOnlyExtraction({
      baselineText: source,
      baselineHash: sourceHash,
      selected,
      targetPath: "packages/contracts/src/model.ts",
      moduleSpecifier: "./model.ts",
      targetImports: [],
      inlineImportTypeProofs: [proof],
      compatibility: { reExportNames: ["Model"], donorImports: [] },
    });
    expect(result.target.text).toContain('import("../../../apps/example/src/models.ts").Model');

    const base = {
      baselineText: source,
      baselineHash: sourceHash,
      selected,
      targetPath: "packages/contracts/src/model.ts",
      moduleSpecifier: "./model.ts",
      targetImports: [],
      compatibility: { reExportNames: ["Model"], donorImports: [] },
    } as const;
    expect(() => renderTypeOnlyExtraction(base)).toThrow("exact rewrite proof coverage");
    expect(renderTypeOnlyExtraction({ ...base, inlineImportTypeProofs: [{ ...proof, targetSpecifier: "./models.ts" }] }).target.text).toContain(
      'import("./models.ts").Model',
    );
    expect(() => renderTypeOnlyExtraction({ ...base, inlineImportTypeProofs: [{ ...proof, sourceHash: hashText("tampered") }] })).toThrow(
      "stale, overlapping, or outside",
    );
  });

  test("moves exact documented declarations while preserving all untouched donor bytes", () => {
    const first = span("Item", "interface");
    const second = span("ItemLabel", "type-alias");
    const result = renderTypeOnlyExtraction(input([first, second]));
    const untouched = baseline.slice(0, first.start) + baseline.slice(first.end, second.start) + baseline.slice(second.end);

    expect(result.donor.text.slice(0, untouched.length)).toBe(untouched);
    expect(result.donor.text).toContain('import type { Item } from "./item.ts";');
    expect(result.donor.text).toContain('export type { Item, ItemLabel } from "./item.ts";');
    expect(result.target.path).toBe("packages/contracts/src/item.ts");
    expect(result.target.text).toContain('import type { Remote } from "./remote.ts";');
    expect(result.target.text).toContain("/** A documented public shape. */\nexport interface Item");
    expect(result.target.text).toContain('/** A label derived from the shape. */\nexport type ItemLabel = Item["name"];');
    expect(result.donor.hash).toBe(hashText(result.donor.text));
    expect(result.target.hash).toBe(hashText(result.target.text));
  });

  test("canonicalizes independent input ordering so replay bytes and identity cannot vary", () => {
    const forward = renderTypeOnlyExtraction(input());
    const reversed = renderTypeOnlyExtraction(input([span("ItemLabel", "type-alias"), span("Item", "interface")]));

    expect(reversed).toEqual(forward);
  });

  test("renders only the proven default, namespace, and named type-import forms", () => {
    const result = renderTypeOnlyExtraction({
      ...input([span("Item", "interface")]),
      targetImports: [
        { ...proven("./defaults.ts", "default", "Defaults"), kind: "default" },
        { ...proven("./names.ts", "*", "Names"), kind: "namespace" },
        proven("./defaults.ts", "Remote"),
      ],
    });

    expect(result.target.text).toContain('import type Defaults, { Remote } from "./defaults.ts";');
    expect(result.target.text).toContain('import type * as Names from "./names.ts";');
  });

  test("moves a private dependency into the target without leaking it from the donor", () => {
    const source = "interface Local { id: string }\nexport interface Public { local: Local }\n";
    const localText = "interface Local { id: string }";
    const publicText = "export interface Public { local: Local }";
    const sourceHash = hashText(source);
    const localStart = source.indexOf(localText);
    const publicStart = source.indexOf(publicText);
    const result = renderTypeOnlyExtraction({
      baselineText: source,
      baselineHash: sourceHash,
      selected: [
        { start: localStart, end: localStart + localText.length, hash: hashText(localText), name: "Local", kind: "interface", originallyExported: false },
        { start: publicStart, end: publicStart + publicText.length, hash: hashText(publicText), name: "Public", kind: "interface", originallyExported: true },
      ],
      targetPath: "packages/contracts/src/public.ts",
      moduleSpecifier: "./public.ts",
      targetImports: [],
      compatibility: { reExportNames: ["Public"], donorImports: [] },
    });

    expect(result.target.text).toContain("export interface Local { id: string }");
    expect(result.target.text).toContain("export interface Public { local: Local }");
    expect(result.donor.text).toContain('export type { Public } from "./public.ts";');
    expect(result.donor.text).not.toContain("export type { Local");
    const localProof = result.declarations.find((item) => item.name === "Local");
    if (!localProof) throw new Error("missing Local replay proof");
    expect(localProof.synthesizedExport).toBe(true);
    expect(result.target.text.slice(localProof.targetSpan.start, localProof.targetSpan.end)).toBe("export interface Local { id: string }");
    expect(localProof.targetSpan.hash).not.toBe(localProof.source.hash);
    expect(result.target.text.slice(localProof.targetExtraction.start, localProof.targetExtraction.end)).toBe("export interface Local { id: string }");
  });

  test("preserves ambient modifiers on declarations whose JavaScript emit is empty", () => {
    const source = "export declare type LocalName = string;\nexport declare interface PublicShape { name: LocalName }\n";
    const local = "export declare type LocalName = string;";
    const publicShape = "export declare interface PublicShape { name: LocalName }";
    const result = renderTypeOnlyExtraction({
      baselineText: source,
      baselineHash: hashText(source),
      selected: [
        { start: 0, end: local.length, hash: hashText(local), name: "LocalName", kind: "type-alias", originallyExported: true },
        {
          start: source.indexOf(publicShape),
          end: source.indexOf(publicShape) + publicShape.length,
          hash: hashText(publicShape),
          name: "PublicShape",
          kind: "interface",
          originallyExported: true,
        },
      ],
      targetPath: "packages/contracts/src/public-shape.ts",
      moduleSpecifier: "./public-shape.ts",
      targetImports: [],
      compatibility: { reExportNames: ["LocalName", "PublicShape"], donorImports: [] },
    });

    expect(result.target.text).toContain("export declare type LocalName = string;");
    expect(result.target.text).toContain("export declare interface PublicShape { name: LocalName }");
    expect(ts.transpileModule(result.target.text, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText).toBe("export {};\n");

    const global = "declare interface GlobalShape { value: string }";
    expect(() =>
      renderTypeOnlyExtraction({
        baselineText: global,
        baselineHash: hashText(global),
        selected: [{ start: 0, end: global.length, hash: hashText(global), name: "GlobalShape", kind: "interface", originallyExported: false }],
        targetPath: "packages/contracts/src/global.ts",
        moduleSpecifier: "./global.ts",
        targetImports: [],
        compatibility: { reExportNames: [], donorImports: [] },
      }),
    ).toThrow("potentially global visibility");
  });

  test("refuses a compatibility policy that accidentally exposes a private closure type", () => {
    const source = "interface Local { id: string }\nexport interface Public { local: Local }\n";
    const localText = "interface Local { id: string }";
    const publicText = "export interface Public { local: Local }";
    const sourceHash = hashText(source);
    expect(() =>
      renderTypeOnlyExtraction({
        baselineText: source,
        baselineHash: sourceHash,
        selected: [
          { start: 0, end: localText.length, hash: hashText(localText), name: "Local", kind: "interface", originallyExported: false },
          {
            start: source.indexOf(publicText),
            end: source.indexOf(publicText) + publicText.length,
            hash: hashText(publicText),
            name: "Public",
            kind: "interface",
            originallyExported: true,
          },
        ],
        targetPath: "packages/contracts/src/public.ts",
        moduleSpecifier: "./public.ts",
        targetImports: [],
        compatibility: { reExportNames: ["Local", "Public"], donorImports: [] },
      }),
    ).toThrow("must exactly match the selected declarations' original public names");
  });

  test("refuses a stale source span instead of extracting changed bytes", () => {
    const selected = span("Item", "interface");
    expect(() => renderTypeOnlyExtraction(input([{ ...selected, hash: hashText("different bytes") }]))).toThrow("selected span for Item is stale");
  });

  test("refuses overlapping spans rather than silently deleting an unchecked range", () => {
    const selected = span("Item", "interface");
    const overlap = { ...selected, start: selected.start + 4, hash: hashText(baseline.slice(selected.start + 4, selected.end)) };
    expect(() => renderTypeOnlyExtraction(input([selected, overlap]))).toThrow("selected spans overlap");
  });

  test("refuses value declarations and checker proofs from another donor revision", () => {
    const selected = span("Item", "interface");
    expect(() => renderTypeOnlyExtraction(input([{ ...selected, kind: "type-alias" }]))).toThrow("no longer matches its type-only declaration proof");
    expect(() => renderTypeOnlyExtraction(input([{ ...selected, originallyExported: false }]))).toThrow("no longer matches its original export proof");
    const staleProof = { ...input(), targetImports: [{ ...proven("./remote.ts", "Remote"), proofBaselineHash: hashText("old donor") }] };
    expect(() => renderTypeOnlyExtraction(staleProof)).toThrow(PreparationReplayError);
  });
});
