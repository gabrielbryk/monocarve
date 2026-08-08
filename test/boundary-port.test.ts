/**
 * `planPortBoundary` — the "port" strategy: promote a type-only declaration
 * out of a retained app module into a contract module, plus (when declared)
 * an app-owned adapter authored only from a reviewed template. Every emitted
 * artifact must be an ordinary, reviewable write-file/rewrite-module-specifier
 * operation — never hidden generator behaviour.
 */

import { afterAll, describe, expect, test } from "bun:test";
import ts from "typescript";

import { BoundaryPortError, planPortBoundary, type PortConsumerInput } from "../src/prepare/boundary-port.ts";
import type { ResolvedPortBoundary } from "../src/prepare/boundary-resolve.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
};

const RETAINED = "apps/api/src/widget.ts";
const RETAINED_SOURCE = "export interface Widget { amount: number }\n";
const CONSUMER_PATH = "apps/api/src/orders/service.ts";
const CONSUMER_SOURCE =
  'import type { Widget } from "../widget.ts";\nexport function run(input: Widget): void { void input; }\n';
const CONTRACT_TARGET_PATH = "libs/ports/src/widget.ts";
const ADAPTER_PATH = "apps/api/src/widget-adapter.ts";
const ADAPTER_TEMPLATE_TEXT = "export class Widget {\n  amount = 0;\n}\n";

function boundary(overrides: Partial<ResolvedPortBoundary> = {}): ResolvedPortBoundary {
  return {
    id: "widget-port",
    source: "compositionBoundaries",
    strategy: "port",
    retained: RETAINED,
    declarationName: "Widget",
    contractName: "Widget",
    contractPackage: "@acme/ports/widget",
    contractModule: "widget",
    packageImport: "@acme/ports/widget",
    symbols: ["Widget"],
    appAdapter: ADAPTER_PATH,
    template: "widget-adapter",
    retainedRoots: [RETAINED],
    retire: false,
    ...overrides,
  };
}

function consumer(overrides: Partial<PortConsumerInput> = {}): PortConsumerInput {
  return {
    path: CONSUMER_PATH,
    preconditionHash: hashText(CONSUMER_SOURCE),
    mode: 0o644,
    text: CONSUMER_SOURCE,
    specifier: "../widget.ts",
    ...overrides,
  };
}

function repo(): string {
  return fixtureRepo({
    [RETAINED]: RETAINED_SOURCE,
    [CONSUMER_PATH]: CONSUMER_SOURCE,
  });
}

function baseInput(root: string, overrides: Record<string, unknown> = {}) {
  return {
    rootDir: root,
    boundary: boundary(),
    retainedSourceText: RETAINED_SOURCE,
    compilerOptions: COMPILER_OPTIONS,
    contractTargetPath: CONTRACT_TARGET_PATH,
    consumers: [consumer()],
    adapterTemplateText: ADAPTER_TEMPLATE_TEXT,
    ...overrides,
  };
}

describe("planPortBoundary", () => {
  test("emits the contract module and app adapter as ordinary write-file operations with real content", () => {
    const root = repo();
    const result = planPortBoundary(baseInput(root));

    expect(result.contract.kind).toBe("write-file");
    expect(result.contract.purpose).toBe("port-contract");
    expect(result.contract.contents).toBe("export interface Widget { amount: number }\n");
    expect(result.contract.file).toMatchObject({ path: CONTRACT_TARGET_PATH, preconditionMode: "missing" });

    expect(result.adapter?.kind).toBe("write-file");
    expect(result.adapter?.purpose).toBe("app-adapter");
    expect(result.adapter?.contents).toBe(ADAPTER_TEMPLATE_TEXT);
    expect(result.adapter?.file).toMatchObject({ path: ADAPTER_PATH, preconditionMode: "missing" });
  });

  test("rewrites domain imports to the contract specifier", () => {
    const root = repo();
    const result = planPortBoundary(baseInput(root));

    expect(result.rewrites).toHaveLength(1);
    const rewrite = result.rewrites[0]!;
    expect(rewrite.contents).toBe(
      'import type { Widget } from "@acme/ports/widget";\nexport function run(input: Widget): void { void input; }\n',
    );
    expect(rewrite.rewrites).toEqual([{ from: "../widget.ts", to: "@acme/ports/widget", symbols: ["Widget"] }]);
  });

  test("the same config and baseline compiles byte-identical manifests twice", () => {
    const root = repo();
    const input = baseInput(root);

    const first = planPortBoundary(input);
    const second = planPortBoundary(input);

    expect(second).toEqual(first);
  });

  test("a boundary requesting an adapter with no reviewed template text is refused rather than invented", () => {
    const root = repo();
    const { adapterTemplateText: _omitted, ...input } = baseInput(root);

    expect(() => planPortBoundary(input)).toThrow(BoundaryPortError);
    expect(() => planPortBoundary(input)).toThrow(/port boundary widget-port declares an appAdapter but no reviewed template text was supplied/);
  });

  test("a boundary with no configured adapter emits no adapter operation", () => {
    const root = repo();
    const result = planPortBoundary(baseInput(root, { boundary: boundary({ appAdapter: undefined, template: undefined }) }));

    expect(result.adapter).toBeUndefined();
  });

  test("promotes an explicitly closed dependent declaration group atomically in source order", () => {
    const retainedSourceText = [
      "export interface DownloadedObject { body: Uint8Array }",
      "export interface ObjectStorage { get(): Promise<DownloadedObject> }",
      "",
    ].join("\n");
    const consumerText = 'import type { ObjectStorage } from "../widget.ts";\nexport type Store = ObjectStorage;\n';
    const result = planPortBoundary(baseInput(repo(), {
      boundary: boundary({ source: "portPromotions", declarationName: "ObjectStorage", contractName: "ObjectStorage", atomicDeclarationGroup: true, symbols: ["DownloadedObject", "ObjectStorage"], appAdapter: undefined, template: undefined }),
      retainedSourceText,
      consumers: [consumer({ text: consumerText, preconditionHash: hashText(consumerText) })],
    }));

    expect(result.contract.contents).toBe(
      "export interface DownloadedObject { body: Uint8Array }\n\nexport interface ObjectStorage { get(): Promise<DownloadedObject> }\n",
    );
    expect(result.rewrites[0]?.rewrites).toEqual([{ from: "../widget.ts", to: "@acme/ports/widget", symbols: ["ObjectStorage"] }]);
  });

  test("refuses an omitted declaration dependency instead of widening the reviewed group", () => {
    const retainedSourceText = "export interface DownloadedObject { body: Uint8Array }\nexport interface ObjectStorage { get(): Promise<DownloadedObject> }\n";
    expect(() => planPortBoundary(baseInput(repo(), {
      boundary: boundary({ source: "portPromotions", declarationName: "ObjectStorage", contractName: "ObjectStorage", atomicDeclarationGroup: true, symbols: ["ObjectStorage"], appAdapter: undefined, template: undefined }),
      retainedSourceText,
    }))).toThrow(/omitted declarations are required/);
  });

  test("refuses a value-space dependency in an otherwise selected group", () => {
    const retainedSourceText = "export const token = Symbol();\nexport interface ObjectStorage { token: typeof token }\n";
    expect(() => planPortBoundary(baseInput(repo(), {
      boundary: boundary({ source: "portPromotions", declarationName: "ObjectStorage", contractName: "ObjectStorage", atomicDeclarationGroup: true, symbols: ["ObjectStorage"], appAdapter: undefined, template: undefined }),
      retainedSourceText,
    }))).toThrow(/value dependency|unsafe/);
  });

  test("leaves an importer of only retained declarations untouched", () => {
    const retainedSourceText = "export interface Widget { amount: number }\nexport const makeWidget = (): Widget => ({ amount: 0 });\n";
    const retainedConsumer = 'import { makeWidget } from "../widget.ts";\nexport const value = makeWidget();\n';
    const result = planPortBoundary(baseInput(repo(), {
      retainedSourceText,
      consumers: [consumer({ text: retainedConsumer, preconditionHash: hashText(retainedConsumer) })],
      boundary: boundary({ appAdapter: undefined, template: undefined }),
    }));

    expect(result.rewrites).toEqual([]);
    expect(result.contract.contents).toBe("export interface Widget { amount: number }\n");
  });

  test("splits a mixed importer, retaining value bindings on the donor and moving only promoted type bindings", () => {
    const retainedSourceText = "export interface Widget { amount: number }\nexport const makeWidget = (): Widget => ({ amount: 0 });\n";
    const mixedConsumer = 'import { type Widget as Input, makeWidget } from "../widget.ts";\nexport const value: Input = makeWidget();\n';
    const result = planPortBoundary(baseInput(repo(), {
      retainedSourceText,
      consumers: [consumer({ text: mixedConsumer, preconditionHash: hashText(mixedConsumer) })],
      boundary: boundary({ appAdapter: undefined, template: undefined }),
    }));

    expect(result.rewrites[0]?.contents).toContain('import { makeWidget } from "../widget.ts";');
    expect(result.rewrites[0]?.contents).toContain('import { type Widget as Input } from "@acme/ports/widget";');
    expect(result.rewrites[0]?.rewrites).toEqual([{
      from: "../widget.ts", to: "@acme/ports/widget", symbols: ["Widget"], retainedSymbols: ["makeWidget"],
    }]);
  });

  test("a mixed importer still refuses a promoted binding used in value space", () => {
    const retainedSourceText = "export interface Widget { amount: number }\nexport const makeWidget = (): Widget => ({ amount: 0 });\n";
    const unsafeConsumer = 'import { Widget, makeWidget } from "../widget.ts";\nexport const value = [Widget, makeWidget()];\n';
    expect(() => planPortBoundary(baseInput(repo(), {
      retainedSourceText,
      consumers: [consumer({ text: unsafeConsumer, preconditionHash: hashText(unsafeConsumer) })],
      boundary: boundary({ appAdapter: undefined, template: undefined }),
    }))).toThrow(/uses Widget in value space/);
  });

  test("rewrites only selected import declarations when one file imports promoted types and retained values separately", () => {
    const retainedSourceText = [
      "export interface DownloadedObject { body: Uint8Array }",
      "export interface ObjectStorage { get(): Promise<DownloadedObject> }",
      "export class ObjectStorageError extends Error {}",
      "",
    ].join("\n");
    const consumerText = [
      'import type { DownloadedObject, ObjectStorage as Store } from "../widget.ts";',
      'import { ObjectStorageError } from "../widget.ts";',
      "export type Result = DownloadedObject | Store;",
      "export const error = new ObjectStorageError();",
      "",
    ].join("\n");
    const result = planPortBoundary(baseInput(repo(), {
      retainedSourceText,
      consumers: [consumer({ text: consumerText, preconditionHash: hashText(consumerText) })],
      boundary: boundary({
        source: "portPromotions", atomicDeclarationGroup: true,
        declarationName: "ObjectStorage", contractName: "ObjectStorage",
        symbols: ["DownloadedObject", "ObjectStorage"], appAdapter: undefined, template: undefined,
      }),
    }));

    expect(result.rewrites[0]?.contents).toContain('import type { DownloadedObject, ObjectStorage as Store } from "@acme/ports/widget";');
    expect(result.rewrites[0]?.contents).toContain('import { ObjectStorageError } from "../widget.ts";');
    expect(result.rewrites[0]?.rewrites).toEqual([{
      from: "../widget.ts", to: "@acme/ports/widget",
      symbols: ["DownloadedObject", "ObjectStorage"], retainedSymbols: ["ObjectStorageError"],
    }]);
  });

  test("refuses an unprovable side-effect import beside a selected declaration", () => {
    const consumerText = 'import type { Widget } from "../widget.ts";\nimport "../widget.ts";\nexport type Input = Widget;\n';
    expect(() => planPortBoundary(baseInput(repo(), {
      consumers: [consumer({ text: consumerText, preconditionHash: hashText(consumerText) })],
      boundary: boundary({ appAdapter: undefined, template: undefined }),
    }))).toThrow(/side-effect import.*cannot prove its retained binding identity/);
  });
});
