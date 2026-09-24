import { expect, test } from "bun:test";
import fs, { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseConfig } from "../src/config.ts";
import { assertReportsBoundToInventory, canonicalInputPath, captureInputInventory, InputInventoryError, verifyInputInventory } from "../src/assessment/input-inventory.ts";
import { scanDependencyReports } from "../src/graph/cruiser.ts";
import { SCANNER_READ_SYMBOL } from "../src/graph/scanner-read-plugin.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

test("scanner observations outside the captured inventory fail closed even when no module reports them", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "unreported"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"],
    packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const inventory = captureInputInventory({ config, configPath: join(root, "monocarve.config.json"), rootDir: root });
  expect(() => assertReportsBoundToInventory(root, inventory, {
    web: { modules: [{ source: "apps/web/src/main.ts", dependencies: [] }], observedReads: ["unreported/child/package.json"] },
  })).toThrow(InputInventoryError);
  try {
    assertReportsBoundToInventory(root, inventory, { web: { modules: [{ source: "apps/web/src/main.ts", dependencies: [] }], observedReads: ["unreported/child/package.json"] } });
  } catch (error) {
    expect(error).toMatchObject({ code: "ASSESSMENT_INPUT_UNBOUND", paths: ["repository:unreported/child/package.json"] });
  }
});

test("captured absence probes are valid observations, not unbound reads", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"],
    packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const inventory = captureInputInventory({ config, configPath: join(root, "missing-config.json"), rootDir: root });
  expect(() => assertReportsBoundToInventory(root, inventory, {
    web: { modules: [{ source: "apps/web/src/main.ts", dependencies: [] }], observedReads: ["missing-config.json"] },
  })).not.toThrow();
  expect(() => assertReportsBoundToInventory(root, inventory, {
    web: { modules: [{ source: "apps/web/src/main.ts", dependencies: [] }], observedReads: ["apps/web/src/main.ts"] },
  }, true)).toThrow(InputInventoryError);
});

test("configured consumer and first-party roots are analytical authority, including local node_modules absence probes", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "apps/web/consumers"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "apps/web/node_modules"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "apps/web/consumers/check.ts"), "import { value } from \"../src/main.ts\"; export const check = value;\n");
  writeFileSync(join(root, "shared/index.ts"), "export const shared = true;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  const configPath = join(root, "monocarve.config.json");
  writeFileSync(configPath, "{}\n");
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", consumerRoots: ["apps/web/consumers"], tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], firstPartyRoots: ["shared"], packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const inventory = captureInputInventory({ config, configPath, rootDir: root });
  expect(inventory.entries).toContainEqual(expect.objectContaining({ namespace: "repository", path: "apps/web/consumers/check.ts", kind: "file" }));
  expect(inventory.entries).toContainEqual(expect.objectContaining({ namespace: "repository", path: "shared/index.ts", kind: "file" }));
  expect(() => assertReportsBoundToInventory(root, inventory, {
    web: { modules: [{ source: "apps/web/src/main.ts", dependencies: [] }], observedReads: ["apps/web/node_modules/@acme/missing/package.json"] },
  })).not.toThrow();
  expect(() => assertReportsBoundToInventory(root, inventory, {
    web: { modules: [{ source: "apps/web/src/main.ts", dependencies: [] }], observedReads: ["apps/web/node_modules/@acme/missing/new/file.js"] },
  })).not.toThrow();
});

test("external inventory entries use dependency-relative names", () => {
  const root = scratchDirectory();
  const dependencyRoot = scratchDirectory();
  const duplicateRoot = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(dependencyRoot, "shared"), { recursive: true });
  mkdirSync(join(duplicateRoot, "shared"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), 'export const value = 1;\n');
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","strict":true},"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(dependencyRoot, "shared/package.json"), '{"name":"@acme/shared","types":"index.d.ts"}\n');
  writeFileSync(join(dependencyRoot, "shared/index.d.ts"), "export type Value = number;\n");
  writeFileSync(join(duplicateRoot, "shared/package.json"), '{"name":"@acme/shared","types":"index.d.ts"}\n');
  writeFileSync(join(duplicateRoot, "shared/index.d.ts"), "export type Value = number;\n");
  symlinkSync(join(dependencyRoot, "shared/index.d.ts"), join(root, "apps/web/src/external.d.ts"));
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const inventory = captureInputInventory({ config, configPath: join(root, "missing-config.json"), rootDir: root });
  const external = inventory.entries.filter((entry) => entry.namespace === "external");
  const link = inventory.entries.find((entry) => entry.path === "apps/web/src/external.d.ts");
  const capturedIdentity = link?.kind === "symlink" ? link.canonicalPath : undefined;
  const duplicate = join(duplicateRoot, "shared/index.d.ts");
  const duplicateIdentity = canonicalInputPath(root, duplicate);
  expect(capturedIdentity).toMatch(/^external:@acme\/shared#[0-9a-f]{64}\/index\.d\.ts$/u);
  expect(external.some((entry) => entry.path.endsWith("/index.d.ts"))).toBeTrue();
  expect(duplicateIdentity).not.toBe(capturedIdentity);
  expect(duplicateIdentity).not.toContain(duplicateRoot);
  expect(() => assertReportsBoundToInventory(root, inventory, {
    web: { modules: [{ source: duplicate, dependencies: [] }], observedReads: [duplicate] },
  })).toThrow(InputInventoryError);
  expect(external.every((entry) => !entry.path.includes(root))).toBeTrue();
  expect(external.some((entry) => entry.path.endsWith("/package.json") && entry.kind === "file")).toBeTrue();
  writeFileSync(join(dependencyRoot, "shared/package.json"), '{"name":"@acme/shared","types":"changed.d.ts"}\n');
  try {
    verifyInputInventory({ config, configPath: join(root, "missing-config.json"), rootDir: root }, inventory);
    throw new Error("external package manifest drift was accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(InputInventoryError);
    expect((error as InputInventoryError).code).toBe("ASSESSMENT_INPUT_DRIFT");
    expect((error as InputInventoryError).paths.some((path) => path.endsWith("/package.json"))).toBeTrue();
  }
});

test("live dependency-cruiser observations are checked against the captured authority", async () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), 'import { value } from "./value.ts"; export const main = value;\n');
  writeFileSync(join(root, "apps/web/src/value.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true},"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(root, "monocarve.config.json"), "{}\n");
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const options = { config, configPath: join(root, "monocarve.config.json"), rootDir: root };
  const inventory = captureInputInventory(options);
  const reports = await scanDependencyReports({ config, rootDir: root, application: "web", noCache: true });
  const report = reports.web;
  if (!report) throw new Error("web report was not captured");
  expect(report.observedReads?.some((path) => path.endsWith("apps/web/src/value.ts"))).toBeTrue();
  expect(report.observedReads?.some((path) => path.endsWith("apps/web/package.json"))).toBeTrue();
  expect(report.observedFileReads?.some((read) => read.path.endsWith("apps/web/src/value.ts"))).toBeTrue();
  expect(report.modules.every((module) => report.observedFileReads?.some((read) => read.path.endsWith(module.source)))).toBeTrue();
  expect(() => assertReportsBoundToInventory(root, inventory, reports)).not.toThrow();
});

test("scanner rejects bytes read during a change-and-restore race", async () => {
  const root = scratchDirectory();
  const sourceDir = join(root, "apps/web/src");
  mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, "value.ts");
  const original = "export const value = 1;\n";
  const changed = "export const value = 2;\n";
  writeFileSync(join(sourceDir, "main.ts"), 'import { value } from "./value.ts"; export const main = value;\n');
  writeFileSync(source, original);
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true},"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  const configPath = join(root, "monocarve.config.json");
  writeFileSync(configPath, "{}\n");
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const options = { config, configPath, rootDir: root };
  const inventory = captureInputInventory(options);
  const globals = globalThis as typeof globalThis & { [SCANNER_READ_SYMBOL]?: (path: unknown, result: unknown) => void };
  const priorReadHook = globals[SCANNER_READ_SYMBOL];
  let altered = false;
  let restored = false;
  globals[SCANNER_READ_SYMBOL] = (path) => {
    if (!altered && typeof path === "string" && resolve(path) === join(sourceDir, "main.ts")) {
      writeFileSync(source, changed);
      altered = true;
    } else if (altered && !restored && typeof path === "string" && resolve(path) === source) {
      writeFileSync(source, original);
      restored = true;
    }
  };
  let reports: Awaited<ReturnType<typeof scanDependencyReports>>;
  try {
    reports = await scanDependencyReports({ config, rootDir: root, application: "web", noCache: true });
  } finally {
    if (priorReadHook === undefined) delete globals[SCANNER_READ_SYMBOL];
    else globals[SCANNER_READ_SYMBOL] = priorReadHook;
  }
  expect(altered).toBeTrue();
  expect(restored).toBeTrue();
  expect(readFileSync(source, "utf8")).toBe(original);
  expect(() => verifyInputInventory(options, inventory)).not.toThrow();
  expect(() => assertReportsBoundToInventory(root, inventory, reports!)).toThrow(InputInventoryError);
  try { assertReportsBoundToInventory(root, inventory, reports!); }
  catch (error) { expect(error).toMatchObject({ code: "ASSESSMENT_INPUT_DRIFT", paths: ["repository:apps/web/src/value.ts"] }); }
});

test("scanner rejects altered tsconfig bytes even when the file is unchanged afterward", async () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), 'import { value } from "./value.ts"; export const main = value;\n');
  writeFileSync(join(root, "apps/web/src/value.ts"), "export const value = 1;\n");
  const tsconfig = join(root, "apps/web/tsconfig.json");
  const original = '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","baseUrl":".","paths":{"alias":["src/value.ts"]}},"include":["src/**/*.ts"]}\n';
  const altered = original.replace("src/value.ts", "src/other.ts");
  writeFileSync(tsconfig, original);
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  const configPath = join(root, "monocarve.config.json");
  writeFileSync(configPath, "{}\n");
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const options = { config, configPath, rootDir: root };
  const inventory = captureInputInventory(options);
  const originalRead = fs.readFileSync;
  let alteredReads = 0;
  fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
    if (typeof path === "string" && resolve(path) === tsconfig) {
      alteredReads++;
      return typeof args[0] === "string" ? altered : Buffer.from(altered);
    }
    return originalRead(path as string, ...(args as []));
  }) as typeof fs.readFileSync;
  let reports: Awaited<ReturnType<typeof scanDependencyReports>>;
  try { reports = await scanDependencyReports({ config, rootDir: root, application: "web", noCache: true }); }
  finally { fs.readFileSync = originalRead; }
  expect(alteredReads).toBeGreaterThan(0);
  expect(readFileSync(tsconfig, "utf8")).toBe(original);
  expect(() => verifyInputInventory(options, inventory)).not.toThrow();
  try {
    assertReportsBoundToInventory(root, inventory, reports!, true);
    throw new Error("altered tsconfig read was accepted");
  } catch (error) {
    expect(error).toMatchObject({ code: "ASSESSMENT_INPUT_DRIFT", paths: ["repository:apps/web/tsconfig.json"] });
  }
});

test("a changed observed read fails inventory verification even when target hashes are unchanged", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  const configPath = join(root, "monocarve.config.json");
  writeFileSync(configPath, "{}\n");
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const options = { config, configPath, rootDir: root };
  const inventory = captureInputInventory(options);
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 2;\n");
  expect(() => verifyInputInventory(options, inventory)).toThrow(InputInventoryError);
});
