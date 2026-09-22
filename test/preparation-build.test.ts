import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { compilePreparationManifest } from "../src/prepare/build.ts";
import type { SeamPlan } from "../src/seams/types.ts";
import { analyzeTypeScriptSource } from "../src/symbols/analyze.ts";
import { resolveCommit } from "../src/util/git.ts";
import { hashText, stableStringify } from "../src/util/hash.ts";
import { fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

const SOURCE_PATH = "src/widget.ts";
const TYPE_SOURCE = [
  'import type { Decimal } from "./decimal.ts";',
  "",
  "/** A transferable widget contract. */",
  "export interface Widget { amount: Decimal; }",
  "export type WidgetList = readonly Widget[];",
  "export const runtimeWidget = 1;",
  "",
].join("\n");

describe("preparation manifest compiler", () => {
  test("builds byte-identical baseline-bound manifests from a reviewed type seam", () => {
    const root = fixtureRepo(fixtureFiles(TYPE_SOURCE));
    const config = fixtureConfig(root, fixturePreparationPolicy());
    const input = buildInput(root, config, TYPE_SOURCE);

    const first = compilePreparationManifest(input);
    const second = compilePreparationManifest(input);

    expect(stableStringify(second)).toBe(stableStringify(first));
    expect(first.createdAt).toBe(resolveCommit(root, "HEAD").committedAt);
    expect(first.baseline.commit).toBe(resolveCommit(root, "HEAD").commit);
    expect(first.changedFiles).toEqual(["src/types/widget-types.ts", SOURCE_PATH]);
    expect(first.operations[0]?.kind).toBe("extract-type-declarations");
    if (first.operations[0]?.kind !== "extract-type-declarations") throw new Error("expected extraction operation");
    expect(first.operations[0].donor).toMatchObject({ preconditionMode: 0o644, resultMode: 0o644 });
    expect(first.operations[0].target).toMatchObject({ preconditionMode: "missing", resultMode: 0o644 });
    expect(first.operations[0].donorContents).toContain('export type { Widget, WidgetList } from "./types/widget-types.js";');
    expect(first.operations[0].targetContents).toContain('import type { Decimal } from "../decimal.ts";');
    expect(first.operations[0].targetImportProofs).toEqual([
      {
        originalSpecifier: "./decimal.ts",
        targetSpecifier: "../decimal.ts",
        resolvedSourcePath: "src/decimal.ts",
        localName: "Decimal",
        importedName: "Decimal",
        kind: "named",
        originallyTypeOnly: true,
        requiredAs: "type",
        proofBaselineHash: hashText(TYPE_SOURCE),
      },
    ]);
  }, 15_000);

  test("refuses a seam whose source evidence is stale", () => {
    const root = fixtureRepo(fixtureFiles(TYPE_SOURCE));
    const config = fixtureConfig(root, fixturePreparationPolicy());
    const input = buildInput(root, config, TYPE_SOURCE);

    expect(() => compilePreparationManifest({ ...input, seam: { ...input.seam, sourceHash: hashText("concurrent edit") } })).toThrow(
      "does not match the resolved baseline donor",
    );
  });

  test("refuses a reviewed runtime declaration even when its source hash is current", () => {
    const source = "export enum RuntimeKind { One }\n";
    const root = fixtureRepo(fixtureFiles(source));
    const config = fixtureConfig(root, fixturePreparationPolicy());
    const graph = analyzeTypeScriptSource({ sourcePath: SOURCE_PATH, sourceText: source });
    const group = graph.groups[0];
    if (!group) throw new Error("fixture needs one declaration group");
    const input = buildInput(root, config, source, [group.id]);

    expect(() => compilePreparationManifest(input)).toThrow("occupies type and/or value space");
  });

  test("refuses when dependency closure expands beyond the reviewed seam", () => {
    const source = "export interface Public { detail: Detail }\ninterface Detail { id: string }\n";
    const root = fixtureRepo(fixtureFiles(source));
    const config = fixtureConfig(root, fixturePreparationPolicy());
    const graph = analyzeTypeScriptSource({ sourcePath: SOURCE_PATH, sourceText: source });
    const reviewed = graph.groups.find((group) => group.name === "Public");
    if (!reviewed) throw new Error("fixture needs a public declaration group");

    expect(() => compilePreparationManifest(buildInput(root, config, source, [reviewed.id]))).toThrow(
      "dependency closure expands beyond the operator-reviewed seam",
    );
  });

  test("compiles declared interfaces and type aliases while retaining their ambient bytes", () => {
    const source = "export declare interface AmbientWidget { name: AmbientName }\nexport declare type AmbientName = string;\n";
    const root = fixtureRepo(fixtureFiles(source));
    const config = fixtureConfig(root, fixturePreparationPolicy());
    const manifest = compilePreparationManifest(buildInput(root, config, source));
    const operation = manifest.operations[0];
    if (operation?.kind !== "extract-type-declarations") throw new Error("expected extraction operation");

    expect(operation.targetContents).toContain("export declare interface AmbientWidget");
    expect(operation.targetContents).toContain("export declare type AmbientName");
    expect(ts.transpileModule(operation.targetContents, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText).toBe("export {};\n");
  });

  test("refuses unresolved commit-subject placeholders instead of creating a plan-id cycle", () => {
    const root = fixtureRepo(fixtureFiles(TYPE_SOURCE));
    const config = fixtureConfig(root, fixturePreparationPolicy());
    const input = buildInput(root, config, TYPE_SOURCE);

    expect(() => compilePreparationManifest({ ...input, rendering: { ...input.rendering, commit: { subject: "chore: prepare {planId}" } } })).toThrow(
      "must be rendered",
    );
  });

  test("refuses a donor-relative import when no target-location rewrite proof was supplied", () => {
    const root = fixtureRepo(fixtureFiles(TYPE_SOURCE));
    const config = fixtureConfig(root, fixturePreparationPolicy());
    const { rewriteRelativeTypeImport: _rewrite, ...input } = buildInput(root, config, TYPE_SOURCE);

    expect(() => compilePreparationManifest(input)).toThrow("requires a configured rewrite proof");
  });

  test("persists and replays exact provenance for relative inline import types", () => {
    const source = 'export type Widget = import("./decimal.ts").Decimal;\n';
    const root = fixtureRepo(fixtureFiles(source));
    const config = fixtureConfig(root, fixturePreparationPolicy());
    const manifest = compilePreparationManifest(buildInput(root, config, source));
    const operation = manifest.operations[0];
    if (operation?.kind !== "extract-type-declarations") throw new Error("expected extraction operation");
    const literal = '"./decimal.ts"';
    expect(operation.inlineImportTypeProofs).toEqual([
      {
        originalSpecifier: "./decimal.ts",
        targetSpecifier: "../decimal.ts",
        resolvedSourcePath: "src/decimal.ts",
        start: source.indexOf(literal),
        end: source.indexOf(literal) + literal.length,
        sourceHash: hashText(literal),
        proofBaselineHash: hashText(source),
      },
    ]);
    expect(operation.targetContents).toContain('import("../decimal.ts").Decimal');
  });
});

function buildInput(root: string, config: ReturnType<typeof fixtureConfig>, sourceText: string, groupIds?: readonly string[]) {
  const graph = analyzeTypeScriptSource({ sourcePath: SOURCE_PATH, sourceText });
  const movedGroups =
    groupIds === undefined ? graph.groups.filter((group) => group.space === "type") : graph.groups.filter((group) => groupIds.includes(group.id));
  const seam = {
    sourcePath: SOURCE_PATH,
    sourceHash: graph.sourceHash,
    movedGroups,
    targetPath: "src/types/widget-types.ts",
    requiredImports: [],
    eligibleForTypeOnlyPreparation: true,
  } as unknown as SeamPlan;
  return {
    rootDir: root,
    config,
    baselineCommit: "HEAD",
    graphDigest: hashText("fresh workspace graph"),
    seam,
    targetPath: "src/types/widget-types.ts",
    targetModuleSpecifier: "./types/widget-types.js",
    reviewedGroupIds: movedGroups.map((group) => group.id),
    rewriteRelativeTypeImport({ originalSpecifier }: { readonly originalSpecifier: string }) {
      if (originalSpecifier !== "./decimal.ts") throw new Error(`unexpected fixture import ${originalSpecifier}`);
      return { targetSpecifier: "../decimal.ts", resolvedSourcePath: "src/decimal.ts" };
    },
    rendering: { commit: { subject: "chore: prepare declaration seam" }, gates: { package: [], project: [], workspace: ["true"] } },
  };
}

function fixturePreparationPolicy() {
  return {
    applications: [{ name: "fixture", sourceRoot: "src", tsconfig: "tsconfig.json", compositionRoots: [] }],
    preparation: { commit: { subject: "chore: prepare declaration seam" }, gates: { package: [], project: [], workspace: ["true"] } },
  };
}

function fixtureFiles(source: string): Record<string, string> {
  return {
    "tsconfig.json": '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","strict":true},"include":["src"]}\n',
    [SOURCE_PATH]: source,
    "src/decimal.ts": "export interface Decimal { readonly value: string; }\n",
  };
}
