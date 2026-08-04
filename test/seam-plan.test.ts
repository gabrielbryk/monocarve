import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { planSeam, SeamPlanningError } from "../src/seams/index.ts";
import { analyzeWorkspaceSymbols } from "../src/symbols/index.ts";
import { stableStringify } from "../src/util/hash.ts";
import { cleanupFixtures, scratchDirectory } from "./support/fixture-repo.ts";

function write(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function workspace(): string {
  const root = join(scratchDirectory(), "seam-plan");
  write(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { strict: true, moduleResolution: "bundler", module: "esnext" },
    include: ["src/**/*.ts"],
  }));
  write(root, "src/hub.ts", `
export interface Invoice { total: number }
export interface Customer { name: string }
export function price(invoice: Invoice): number { return invoice.total }
export function greet(customer: Customer): string { return customer.name }
function alpha(): number { return beta() }
function beta(): number { return alpha() }
`);
  write(root, "src/billing/use.ts", 'import { price, type Invoice } from "../hub"; export const total = (invoice: Invoice) => price(invoice);\n');
  write(root, "src/crm/use.ts", 'import { greet, type Customer } from "../hub"; export const hello = (customer: Customer) => greet(customer);\n');
  return root;
}

function analysisFor(root: string) {
  return analyzeWorkspaceSymbols({
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    sourcePath: "src/hub.ts",
    affinityForPath: (path) => path.includes("/billing/") ? "billing" : path.includes("/crm/") ? "crm" : "shared",
  });
}

function candidateId(analysis: ReturnType<typeof analysisFor>, name: string): string {
  const candidate = analysis.splitCandidates.find((entry) => entry.names.includes(name));
  if (!candidate) throw new Error(`missing ${name} split candidate`);
  return candidate.id;
}

function sourceText(root: string): string {
  return readFileSync(join(root, "src/hub.ts"), "utf8");
}

function planUnsafeSource(name: string, source: string) {
  const root = join(scratchDirectory(), `seam-plan-${name}`);
  write(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { strict: true, moduleResolution: "bundler", module: "esnext" },
    include: ["src/**/*.ts"],
  }));
  write(root, "src/unsafe.ts", source);
  const analysis = analyzeWorkspaceSymbols({
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    sourcePath: "src/unsafe.ts",
    affinityForPath: () => "shared",
  });
  return planSeam({
    analysis,
    sourceText: source,
    candidateId: candidateId(analysis, name),
    targetPath: `src/${name}.types.ts`,
  });
}

afterAll(cleanupFixtures);

test("compiles a deterministic full-SCC partition with exact boundary evidence", () => {
  const root = workspace();
  const analysis = analysisFor(root);
  const input = { analysis, sourceText: sourceText(root), candidateId: candidateId(analysis, "price") };
  const first = planSeam(input);
  const second = planSeam(input);

  expect(stableStringify(first)).toBe(stableStringify(second));
  expect(first.movedGroups.map((group) => group.name)).toEqual(["price"]);
  expect(first.retainedGroups.map((group) => group.name).sort()).toEqual(["Customer", "Invoice", "alpha", "beta", "greet"]);
  expect(first.requiredImports).toEqual([expect.objectContaining({
    importer: "moved", exporter: "retained", importerName: "price", importedName: "Invoice", space: "type", referenceCount: 1, confidence: "exact",
  })]);
  expect(first.affectedConsumers).toEqual([expect.objectContaining({
    groupName: "price", affinity: "billing", consumerPath: "src/billing/use.ts", partition: "moved", confidence: "exact",
  })]);
  expect(first.confidence).toEqual({ partition: "exact", imports: "exact", consumers: "exact", placement: "heuristic" });
  expect(first.eligibleForTypeOnlyPreparation).toBe(false);
  expect(first.typeOnlyPreparationSafety[0]?.evidence.map((item) => item.code)).toContain("function-overload-group");
  expect(first.remainingBlockers.map((blocker) => blocker.code)).toEqual(["function-overload-group", "target-path-not-provided"]);
});

test("keeps a cyclic SCC intact and never calls its cycle broken", () => {
  const root = workspace();
  const analysis = analysisFor(root);
  const plan = planSeam({ analysis, sourceText: sourceText(root), candidateId: candidateId(analysis, "alpha"), targetPath: "src/shared/recursive.ts" });

  expect(plan.movedGroups.map((group) => group.name)).toEqual(["alpha", "beta"]);
  expect(plan.cyclesBroken).toEqual([]);
  expect(plan.cyclesRetained).toHaveLength(1);
  expect(plan.cyclesRetained[0]?.groupIds).toEqual(plan.movedGroups.map((group) => group.id).sort());
  expect(plan.eligibleForTypeOnlyPreparation).toBe(false);
  expect(plan.remainingBlockers.map((blocker) => blocker.code)).toEqual([
    "cyclic-component", "function-overload-group", "function-overload-group", "no-dominant-affinity",
  ]);
});

test("marks a type-only declaration SCC eligible with exact safety evidence", () => {
  const root = workspace();
  const analysis = analysisFor(root);
  const plan = planSeam({
    analysis,
    sourceText: sourceText(root),
    candidateId: candidateId(analysis, "Invoice"),
    targetPath: "src/billing/invoice.ts",
  });

  expect(plan.eligibleForTypeOnlyPreparation).toBe(true);
  expect(plan.typeOnlyPreparationSafety).toEqual([expect.objectContaining({ eligible: true, evidence: [] })]);
});

test("reports enum, mixed type-value, and default-export refusals in the seam", () => {
  const enumeration = planUnsafeSource("RuntimeKind", "export enum RuntimeKind { One }\n");
  const mixed = planUnsafeSource("MergedShape", "export interface MergedShape { id: string }\nexport namespace MergedShape { export const marker = 1 }\n");
  const defaulted = planUnsafeSource("DefaultShape", "export default interface DefaultShape { id: string }\n");

  expect(enumeration.eligibleForTypeOnlyPreparation).toBe(false);
  expect(enumeration.remainingBlockers.map((item) => item.code)).toContain("enum-declaration");
  expect(mixed.eligibleForTypeOnlyPreparation).toBe(false);
  expect(mixed.remainingBlockers.map((item) => item.code)).toContain("type-value-mixed-group");
  expect(defaulted.eligibleForTypeOnlyPreparation).toBe(false);
  expect(defaulted.remainingBlockers.map((item) => item.code)).toContain("default-export");
});

test("canonicalizes a caller-selected target path before it becomes plan identity", () => {
  const root = workspace();
  const analysis = analysisFor(root);
  const id = candidateId(analysis, "price");
  const text = sourceText(root);
  const canonical = planSeam({ analysis, sourceText: text, candidateId: id, targetPath: "src/billing/price.ts" });
  const dotted = planSeam({ analysis, sourceText: text, candidateId: id, targetPath: "./src/billing/price.ts" });

  expect(dotted.targetPath).toBe("src/billing/price.ts");
  expect(dotted.id).toBe(canonical.id);
});

test("refuses a candidate that is absent from the supplied symbol analysis", () => {
  const root = workspace();
  const analysis = analysisFor(root);
  expect(() => planSeam({ analysis, sourceText: sourceText(root), candidateId: "0".repeat(64) })).toThrow(SeamPlanningError);
});
