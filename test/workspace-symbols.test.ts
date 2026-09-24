import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { analyzeCapabilityPartitions, analyzeWorkspaceSymbols, createWorkspaceSymbolProgram, SymbolAnalysisError, WorkspaceProgramError } from "../src/symbols/index.ts";
import { loadConfig } from "../src/config.ts";
import { captureAssessmentSnapshot } from "../src/assessment/snapshot.ts";
import { stableStringify } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

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
}, 15_000);

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

test("inventory-backed TypeScript reads refuse transient consumer bytes and restore before verification", async () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "apps/web/consumers"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  write(root, "apps/web/src/main.ts", "export const main = 1;\n");
  write(root, "apps/web/consumers/check.ts", 'import { main } from "../src/main.ts"; export const check = main;\n');
  write(root, "apps/web/package.json", '{"name":"@acme/web","private":true}\n');
  write(root, "apps/web/tsconfig.json", '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true,"strict":true},"include":["src/**/*.ts"]}\n');
  write(root, "package.json", '{"private":true,"workspaces":[]}\n');
  write(root, "bun.lock", "{}\n");
  write(root, "monocarve.config.json", `${JSON.stringify({
    applications: [{ name: "web", sourceRoot: "apps/web/src", consumerRoots: ["apps/web/consumers"], tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\\n' } },
  }, null, 2)}\n`);
  fixtureGit(root, "init", "-q", "-b", "assessment-fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");

  const config = await loadConfig({ cwd: root });
  const snapshot = await captureAssessmentSnapshot({ ...config, application: "web" });
  const consumer = join(root, "apps/web/consumers/check.ts");
  const original = readFileSync(consumer, "utf8");
  let consumerRead = false;
  let restoredBeforeVerification = false;
  let caught: unknown;
  try {
    createWorkspaceSymbolProgram(root, "apps/web/tsconfig.json", ["apps/web/consumers"], (path) => {
      if (resolve(path) !== resolve(consumer)) return snapshot.readTypeScriptInput(path);
      consumerRead = true;
      writeFileSync(consumer, `${original}export const transient = true;\n`);
      try { return snapshot.readTypeScriptInput(path); }
      finally {
        writeFileSync(consumer, original);
        restoredBeforeVerification = readFileSync(consumer, "utf8") === original;
      }
    });
  } catch (error) { caught = error; }
  expect(consumerRead).toBeTrue();
  expect(restoredBeforeVerification).toBeTrue();
  expect(caught).toMatchObject({ qualification: { diagnostics: [expect.objectContaining({ code: "ASSESSMENT_INPUT_DRIFT" })] } });
  expect(readFileSync(consumer, "utf8")).toBe(original);
  expect(() => snapshot.verify()).not.toThrow();
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

test("orders equal-affinity keys by UTF-16 code unit and exposes config parse failures", () => {
  const root = workspace();
  write(root, "src/tie.ts", "export function tie(): number { return 1 }\n");
  write(root, "src/billing/tie-user.ts", 'import { tie } from "../tie"; export const billing = tie();\n');
  write(root, "src/crm/tie-user.ts", 'import { tie } from "../tie"; export const crm = tie();\n');
  const analysis = analyzeWorkspaceSymbols({
    rootDir: root, tsconfigPath: "tsconfig.json", sourcePath: "src/tie.ts",
    affinityForPath: (path) => path.includes("/billing/") ? "Z" : path.includes("/crm/") ? "a" : "shared",
  });
  const candidate = analysis.splitCandidates.find((entry) => entry.names.includes("tie"));
  expect(candidate).toBeDefined();
  expect(Object.keys(candidate?.affinities ?? {})).toEqual(["Z", "a"]);

  writeFileSync(join(root, "tsconfig.json"), "{ \"compilerOptions\": { \"module\": \"esnext\",\n");
  expect(() => createWorkspaceSymbolProgram(root, "tsconfig.json")).toThrow(WorkspaceProgramError);
  try {
    createWorkspaceSymbolProgram(root, "tsconfig.json");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceProgramError);
    expect((error as WorkspaceProgramError).completenessDiagnostics).toContainEqual(expect.objectContaining({ phase: "configuration", category: "error" }));
  }
});
