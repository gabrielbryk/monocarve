import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";

import { resetCodemodCaches, rewriteResolvedImportSpecifier } from "../../src/codemod/imports.ts";

const DONOR_SPECIFIERS = ["./helpers", "./helpers.js", "./helpers.ts"] as const;
const OTHER_SPECIFIERS = ["./unrelated", "./unrelated.js", "node:path", "@acme/other"] as const;
export const SHORT_PACKAGE = "@a/b";
export const LONG_PACKAGE = "@acme/analytics-with-a-deliberately-long-name";

function pick<T>(items: readonly T[], index: number): T {
  const item = items[((index % items.length) + items.length) % items.length];
  if (item === undefined) throw new Error("empty corpus");
  return item;
}

interface Fragment {
  readonly id: string;
  readonly build: (quote: string, specifier: string, index: number) => string;
  readonly tsx?: boolean;
}

const REFERENCES: readonly Fragment[] = [
  { id: "default-import", build: (q, s, i) => `import d${i} from ${q}${s}${q};` },
  { id: "named-import", build: (q, s, i) => `import { a as n${i} } from ${q}${s}${q};` },
  { id: "namespace-import", build: (q, s, i) => `import * as ns${i} from ${q}${s}${q};` },
  { id: "bindingless-import", build: (q, s) => `import ${q}${s}${q};` },
  { id: "type-only-import", build: (q, s, i) => `import type { B as T${i} } from ${q}${s}${q};` },
  { id: "inline-type-import", build: (q, s, i) => `import { type B as I${i} } from ${q}${s}${q};` },
  { id: "export-from", build: (q, s, i) => `export { a as e${i} } from ${q}${s}${q};` },
  { id: "export-star", build: (q, s) => `export * from ${q}${s}${q};` },
  { id: "export-star-as", build: (q, s, i) => `export * as es${i} from ${q}${s}${q};` },
  { id: "export-type-from", build: (q, s, i) => `export type { B as ET${i} } from ${q}${s}${q};` },
  { id: "dynamic-import", build: (q, s, i) => `const dy${i} = import(${q}${s}${q});` },
  { id: "awaited-dynamic-import", build: (q, s, i) => `const aw${i} = await import(${q}${s}${q});` },
  { id: "require-call", build: (q, s, i) => `const rq${i} = require(${q}${s}${q});` },
  { id: "require-resolve", build: (q, s, i) => `const rr${i} = require.resolve(${q}${s}${q});` },
  { id: "import-equals", build: (q, s, i) => `import ie${i} = require(${q}${s}${q});` },
  { id: "import-type-node", build: (q, s, i) => `type IT${i} = import(${q}${s}${q}).B;` },
  { id: "import-type-in-signature", build: (q, s, i) => `const fn${i} = (x: import(${q}${s}${q}).B): void => { void x; };` },
  { id: "multiline-import", build: (q, s, i) => `import {\n  a as ml${i},\n} from\n  ${q}${s}${q};` },
  { id: "block-comment-in-declaration", build: (q, s, i) => `import /* an ordinary note */ { a as bc${i} } from ${q}${s}${q};` },
  { id: "line-comment-in-declaration", build: (q, s, i) => `import {\n  // an ordinary note\n  a as lc${i},\n} from ${q}${s}${q};` },
  { id: "import-attributes", build: (q, s, i) => `import at${i} from ${q}${s}${q} with { type: ${q}json${q} };` },
  { id: "deep-dynamic-import", build: (q, s, i) => `const dp${i} = { load: () => import(${q}${s}${q}) };` },
  { id: "template-dynamic-import", build: (_q, s, i) => `const tp${i} = import(\`${s}\`);` },
  { id: "template-require", build: (_q, s, i) => `const tr${i} = require(\`${s}\`);` },
  { id: "template-import-type", build: (_q, s, i) => `type TT${i} = import(\`${s}\`).B;` },
];

const DECOYS: readonly Fragment[] = [
  { id: "plain-string", build: (q, s, i) => `const s${i} = ${q}${s}${q};` },
  { id: "object-value", build: (q, s, i) => `const o${i} = { path: ${q}${s}${q} };` },
  { id: "template-string", build: (_q, s, i) => `const t${i} = \`${s}\`;` },
  { id: "commented-out-import", build: (q, s, i) => `// import { a } from ${q}${s}${q}; // kept for k${i}` },
  { id: "call-argument", build: (q, s, i) => `const c${i} = String(${q}${s}${q});` },
  { id: "decorator-argument", build: (q, s, i) => `@Deco({ selector: ${q}${s}${q} })\nclass K${i} {}` },
  { id: "jsx-attribute", tsx: true, build: (q, s, i) => `export const V${i} = () => <div className=${q}${s}${q} data-x={1} />;` },
];

export interface Shape {
  readonly id: string;
  readonly eol: "\n" | "\r\n";
  readonly bom: boolean;
  readonly trailingNewline: boolean;
  readonly tsx: boolean;
  readonly indent: string;
  readonly trailingSpace: string;
}

export const SHAPES: readonly Shape[] = [
  { id: "lf", eol: "\n", bom: false, trailingNewline: true, tsx: false, indent: "", trailingSpace: "" },
  { id: "lf-no-final-newline", eol: "\n", bom: false, trailingNewline: false, tsx: false, indent: "", trailingSpace: "" },
  { id: "crlf", eol: "\r\n", bom: false, trailingNewline: true, tsx: false, indent: "", trailingSpace: "" },
  { id: "crlf-bom-no-final-newline", eol: "\r\n", bom: true, trailingNewline: false, tsx: false, indent: "", trailingSpace: "" },
  { id: "tab-indent", eol: "\n", bom: false, trailingNewline: true, tsx: false, indent: "\t", trailingSpace: "" },
  { id: "trailing-space", eol: "\n", bom: false, trailingNewline: true, tsx: false, indent: "", trailingSpace: "  " },
  { id: "tsx-lf", eol: "\n", bom: false, trailingNewline: true, tsx: true, indent: "", trailingSpace: "" },
  { id: "tsx-crlf-bom-tabs", eol: "\r\n", bom: true, trailingNewline: false, tsx: true, indent: "\t", trailingSpace: " " },
];

export interface GeneratedCase {
  readonly id: string;
  readonly path: string;
  readonly source: string;
  readonly donorSpecifiers: ReadonlySet<string>;
  readonly donorReferences: number;
}

interface Slot {
  readonly fragment: Fragment;
  readonly specifier: string;
  readonly reference: boolean;
}

export function render(lines: readonly string[], shape: Shape): string {
  const body = lines
    .flatMap((line) => line.split("\n"))
    .map((line) => shape.indent + line + shape.trailingSpace)
    .join(shape.eol);
  return (shape.bom ? "﻿" : "") + body + (shape.trailingNewline ? shape.eol : "");
}

function decoyFor(shape: Shape, index: number): Fragment {
  const usable = DECOYS.filter((decoy) => shape.tsx || decoy.tsx !== true);
  return pick(usable, index);
}

function buildCase(id: string, shape: Shape, slots: readonly Slot[], tsImporter: string, tsxImporter: string): GeneratedCase {
  const lines: string[] = [];
  const donorSpecifiers = new Set<string>();
  let donorReferences = 0;
  slots.forEach((slot, position) => {
    const quote = (position + id.length) % 2 === 0 ? '"' : "'";
    lines.push(slot.fragment.build(quote, slot.specifier, position));
    if (!(DONOR_SPECIFIERS as readonly string[]).includes(slot.specifier)) return;
    donorSpecifiers.add(slot.specifier);
    if (slot.reference) donorReferences += 1;
  });
  return { id: `${id}/shape:${shape.id}`, path: shape.tsx ? tsxImporter : tsImporter, source: render(lines, shape), donorSpecifiers, donorReferences };
}

function generateCases(tsImporter: string, tsxImporter: string): GeneratedCase[] {
  const cases: GeneratedCase[] = [];
  REFERENCES.forEach((fragment, i) => {
    if (fragment.tsx === true) return;
    SHAPES.forEach((shape, s) => {
      const decoy = decoyFor(shape, i + s);
      cases.push(
        buildCase(
          `single:${String(i).padStart(2, "0")}:${fragment.id}+${decoy.id}`,
          shape,
          [
            { fragment, specifier: pick(DONOR_SPECIFIERS, i), reference: true },
            { fragment: decoy, specifier: pick(DONOR_SPECIFIERS, i + 1), reference: false },
          ],
          tsImporter,
          tsxImporter,
        ),
      );
    });
  });

  REFERENCES.forEach((left, i) => {
    REFERENCES.forEach((right, j) => {
      const shape = pick(SHAPES, i * REFERENCES.length + j);
      const mode = (i * 31 + j) % 4;
      const leftDonor = mode === 0 || mode === 2;
      const rightDonor = mode === 1 || mode === 2;
      const decoy = decoyFor(shape, i * 7 + j);
      cases.push(
        buildCase(
          `pair:${String(i).padStart(2, "0")}x${String(j).padStart(2, "0")}:${left.id}+${right.id}+${decoy.id}`,
          shape,
          [
            { fragment: left, specifier: leftDonor ? pick(DONOR_SPECIFIERS, i) : pick(OTHER_SPECIFIERS, i + j), reference: true },
            { fragment: decoy, specifier: pick(DONOR_SPECIFIERS, i + j), reference: false },
            { fragment: right, specifier: rightDonor ? pick(DONOR_SPECIFIERS, j) : pick(OTHER_SPECIFIERS, i + j + 1), reference: true },
          ],
          tsImporter,
          tsxImporter,
        ),
      );
    });
  });
  return cases;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isModuleCall(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(expression) && expression.text === "require") return true;
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.name.text === "resolve"
  );
}

export function specifierSpans(source: string, path: string, donorSpecifiers: ReadonlySet<string>): Span[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const spans: Span[] = [];
  const consider = (node: ts.Node | undefined): void => {
    if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return;
    if (!donorSpecifiers.has(node.text)) return;
    spans.push({ start: node.getStart(file) + 1, end: node.end - 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) consider(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node)) consider(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node)) consider(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      consider(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && isModuleCall(node)) {
      consider(node.arguments.length === 1 ? node.arguments[0] : undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return spans.sort((left, right) => left.start - right.start);
}

export function spliceAll(source: string, spans: readonly Span[], text: string): string {
  return [...spans]
    .toSorted((left, right) => right.start - left.start)
    .reduce((result, span) => result.slice(0, span.start) + text + result.slice(span.end), source);
}

const SPECIFIER_SENTINEL = "\u0000";

export function skeleton(source: string, spans: readonly Span[]): string {
  return spliceAll(source, spans, SPECIFIER_SENTINEL);
}

function firstDifference(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) if (left[index] !== right[index]) return index;
  return left.length === right.length ? -1 : limit;
}

type Reportable = Pick<GeneratedCase, "id" | "path" | "source">;

export function report(kase: Reportable, expected: string, actual: string): string {
  const at = firstDifference(expected, actual);
  const window = (value: string): string => JSON.stringify(value.slice(Math.max(0, at - 40), at + 40));
  return [
    `case ${kase.id}`,
    `  importer  ${kase.path}`,
    `  source    ${JSON.stringify(kase.source)}`,
    `  first difference at byte ${at}`,
    `  expected  ${window(expected)}`,
    `  actual    ${window(actual)}`,
  ].join("\n");
}

export function assertNoFailures(failures: readonly string[]): void {
  const summary = failures.length === 0 ? "" : `${failures.length} failing case(s):\n${failures.slice(0, 3).join("\n\n")}`;
  expect(summary).toBe("");
}

export function createCodemodPropertyHarness() {
  const workspace = mkdtempSync(join(tmpdir(), "monocarve-codemod-properties-"));
  const DONOR = join(workspace, "helpers.ts");
  const OTHER_FILE = join(workspace, "unrelated.ts");
  const ABSENT_DONOR = join(workspace, "nothing-names-this.ts");
  const TS_IMPORTER = join(workspace, "service.ts");
  const TSX_IMPORTER = join(workspace, "service.tsx");
  writeFileSync(DONOR, "export const a = 1;\nexport type B = string;\n");
  writeFileSync(OTHER_FILE, "export const u = 1;\nexport type V = number;\n");
  resetCodemodCaches();

  const CASES = generateCases(TS_IMPORTER, TSX_IMPORTER);
  const MATCHING_CASES = CASES.filter((kase) => kase.donorReferences > 0);
  const NON_MATCHING_CASES = CASES.filter((kase) => kase.donorReferences === 0);

  return {
    workspace,
    DONOR,
    ABSENT_DONOR,
    TS_IMPORTER,
    TSX_IMPORTER,
    CASES,
    MATCHING_CASES,
    NON_MATCHING_CASES,
    caseById: (id: string): GeneratedCase | undefined => CASES.find((kase) => kase.id === id),
    rewrite: (kase: GeneratedCase, donorPath: string, packageSpecifier: string): string =>
      rewriteResolvedImportSpecifier(kase.source, kase.path, donorPath, packageSpecifier, workspace),
    cleanup: (): void => {
      rmSync(workspace, { recursive: true, force: true });
      resetCodemodCaches();
    },
  };
}
