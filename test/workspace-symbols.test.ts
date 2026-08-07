import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { analyzeCapabilityPartitions, analyzeWorkspaceSymbols, SymbolAnalysisError } from "../src/symbols/index.ts";
import { stableStringify } from "../src/util/hash.ts";
import { cleanupFixtures, scratchDirectory } from "./support/fixture-repo.ts";

function write(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function workspace(): string {
  const root = join(scratchDirectory(), "workspace-symbols");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, moduleResolution: "bundler", module: "esnext" }, include: ["src/**/*.ts"] }));
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

afterAll(cleanupFixtures);

test("maps external type/value consumers to deterministic affinity-ranked declaration SCCs", () => {
  const root = workspace();
  const analyze = () => analyzeWorkspaceSymbols({
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    sourcePath: "src/hub.ts",
    affinityForPath: (path) => path.includes("/billing/") ? "billing" : path.includes("/crm/") ? "crm" : "shared",
  });
  const first = analyze();
  const second = analyze();
  expect(stableStringify(first)).toBe(stableStringify(second));
  expect(first.consumers.map(({ groupName, affinity, space, referenceCount }) => ({ groupName, affinity, space, referenceCount }))).toEqual([
    { groupName: "Customer", affinity: "crm", space: "type", referenceCount: 1 },
    { groupName: "Invoice", affinity: "billing", space: "type", referenceCount: 1 },
    { groupName: "greet", affinity: "crm", space: "value", referenceCount: 1 },
    { groupName: "price", affinity: "billing", space: "value", referenceCount: 1 },
  ]);
  const price = first.splitCandidates.find((candidate) => candidate.names.includes("price"));
  expect(price).toMatchObject({ dominantAffinity: "billing", affinityConcentration: 1, exported: true });
  const recursive = first.splitCandidates.find((candidate) => candidate.names.includes("alpha"));
  expect(recursive?.names).toEqual(["alpha", "beta"]);
  expect(recursive?.consumers).toEqual([]);
  expect(first.source.diagnostics).toEqual([]);
});

test("reports unresolved imports from the workspace program without inventing resolution failures", () => {
  const root = workspace();
  write(root, "src/hub.ts", 'import type { Missing } from "./missing"; export interface Invoice { total: Missing }\n');
  const analysis = analyzeWorkspaceSymbols({
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    sourcePath: "src/hub.ts",
    affinityForPath: () => "shared",
  });
  expect(analysis.source.diagnostics).toContainEqual(expect.objectContaining({
    phase: "semantic",
    code: 2307,
    category: "error",
  }));
});

test("refuses a target outside the configured TypeScript program", () => {
  const root = workspace();
  write(root, "outside.ts", "export const outside = 1;\n");
  expect(() => analyzeWorkspaceSymbols({
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    sourcePath: "outside.ts",
    affinityForPath: () => "shared",
  })).toThrow(SymbolAnalysisError);
});

test("partitions broad context properties by real consumer affinity", () => {
  const root = workspace();
  write(root, "src/context.ts", "export interface Runtime { billing: string; crm: string; unused: string }\n");
  write(root, "src/billing/runtime.ts", 'import type { Runtime } from "../context"; export const bill = (runtime: Runtime) => runtime.billing;\n');
  write(root, "src/crm/runtime.ts", 'import type { Runtime } from "../context"; export const contact = (runtime: Runtime) => runtime.crm;\n');
  const report = analyzeCapabilityPartitions({
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    sourcePath: "src/context.ts",
    interfaceName: "Runtime",
    affinityForPath: (path) => path.includes("/billing/") ? "billing" : path.includes("/crm/") ? "crm" : "shared",
  });
  expect(report.partitions).toEqual([
    { affinities: ["billing"], properties: ["billing"], declarations: ["bill"] },
    { affinities: ["crm"], properties: ["crm"], declarations: ["contact"] },
  ]);
  expect(report.unusedProperties).toEqual(["unused"]);
});
