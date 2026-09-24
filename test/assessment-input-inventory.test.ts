import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../src/config.ts";
import { assertReportsBoundToInventory, canonicalInputPath, captureInputInventory, InputInventoryError, verifyInputInventory } from "../src/assessment/input-inventory.ts";
import { canonicalizeScanReport } from "../src/assessment/report-paths.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

test("input inventory rejects source membership, consumer, config, package export, and symlink drift", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "packages/tool/src"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), 'import { value } from "./consumer.ts"; export { value };\n');
  writeFileSync(join(root, "apps/web/src/consumer.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "apps/web/src/target-a.ts"), "export const target = 'a';\n");
  writeFileSync(join(root, "apps/web/src/target-b.ts"), "export const target = 'b';\n");
  symlinkSync("target-a.ts", join(root, "apps/web/src/link.ts"));
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"compilerOptions":{"allowImportingTsExtensions":true,"noEmit":true},"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "packages/tool/package.json"), '{"name":"@acme/tool","exports":{".":"./src/index.ts"}}\n');
  writeFileSync(join(root, "packages/tool/src/index.ts"), "export {};\n");
  writeFileSync(join(root, "package.json"), '{"private":true,"workspaces":["packages/*"]}\n');
  writeFileSync(join(root, "bun.lock"), "{}\n");
  const configPath = join(root, "monocarve.config.json");
  writeFileSync(configPath, '{}\n');
  fixtureGit(root, "init", "-q"); fixtureGit(root, "config", "user.email", "fixture@example.invalid"); fixtureGit(root, "config", "user.name", "Fixture"); fixtureGit(root, "add", "."); fixtureGit(root, "commit", "-qm", "fixture");
  const config = parseConfig({ applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }], packageRoots: ["packages"], packageManager: "bun", scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } } });
  const options = { config, configPath, rootDir: root };
  const assertDrift = (mutate: () => void, restore: () => void): void => {
    const inventory = captureInputInventory(options); mutate();
    expect(() => verifyInputInventory(options, inventory)).toThrow(InputInventoryError);
    restore();
  };
  assertDrift(() => writeFileSync(join(root, "apps/web/src/added.ts"), "export {};\n"), () => unlinkSync(join(root, "apps/web/src/added.ts")));
  assertDrift(() => writeFileSync(join(root, "apps/web/src/consumer.ts"), "export const value = 2;\n"), () => writeFileSync(join(root, "apps/web/src/consumer.ts"), "export const value = 1;\n"));
  assertDrift(() => writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":[]}\n'), () => writeFileSync(join(root, "apps/web/tsconfig.json"), '{"compilerOptions":{"allowImportingTsExtensions":true,"noEmit":true},"include":["src/**/*.ts"]}\n'));
  assertDrift(() => writeFileSync(join(root, "packages/tool/package.json"), '{"name":"@acme/tool","exports":{}}\n'), () => writeFileSync(join(root, "packages/tool/package.json"), '{"name":"@acme/tool","exports":{".":"./src/index.ts"}}\n'));
  assertDrift(() => { unlinkSync(join(root, "apps/web/src/link.ts")); symlinkSync("target-b.ts", join(root, "apps/web/src/link.ts")); }, () => { unlinkSync(join(root, "apps/web/src/link.ts")); symlinkSync("target-a.ts", join(root, "apps/web/src/link.ts")); });
});

test("input inventory captures JSONC and package tsconfig inheritance", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "node_modules/@acme/config"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{// comment\n"extends":"@acme/config/tsconfig.json","include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "node_modules/@acme/config/package.json"), '{"name":"@acme/config","version":"1.0.0"}\n');
  const parent = join(root, "node_modules/@acme/config/tsconfig.json");
  writeFileSync(parent, '{// inherited comment\n"compilerOptions":{"strict":true}}\n');
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
  expect(inventory.entries).toContainEqual(expect.objectContaining({ namespace: "installed", path: "node_modules/@acme/config/tsconfig.json", kind: "file" }));
  writeFileSync(parent, '{// inherited comment\n"compilerOptions":{"strict":false}}\n');
  expect(() => verifyInputInventory(options, inventory)).toThrow(InputInventoryError);
});

test("input inventory captures side-effect and package config imports", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "node_modules/@acme/config"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  const packageFile = join(root, "node_modules/@acme/config/index.js");
  writeFileSync(join(root, "node_modules/@acme/config/package.json"), '{"name":"@acme/config","main":"index.js"}\n');
  writeFileSync(packageFile, "export const setting = 1;\n");
  const sideEffect = join(root, "setup.ts");
  writeFileSync(sideEffect, "export const initialized = true;\n");
  const configPath = join(root, "monocarve.config.ts");
  writeFileSync(configPath, 'import "./setup.ts";\nimport { setting } from "@acme/config";\nexport default { setting };\n');
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
  expect(inventory.entries).toContainEqual(expect.objectContaining({ namespace: "repository", path: "setup.ts", kind: "file" }));
  expect(inventory.entries).toContainEqual(expect.objectContaining({ namespace: "installed", path: "node_modules/@acme/config/index.js", kind: "file" }));
  writeFileSync(sideEffect, "export const initialized = false;\n");
  expect(() => verifyInputInventory(options, inventory)).toThrow(InputInventoryError);
  writeFileSync(sideEffect, "export const initialized = true;\n");
  writeFileSync(packageFile, "export const setting = 2;\n");
  expect(() => verifyInputInventory(options, inventory)).toThrow(InputInventoryError);
});

test("batch authority covers transitive declarations reached only from configured consumers", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(join(root, "apps/web/consumers"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "vendor/feature"), { recursive: true });
  mkdirSync(join(root, "node_modules/@acme/transitive"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "apps/web/consumers/check.ts"), 'import type { Public } from "../../vendor/feature/index.ts"; export const check: Public = { value: 1 };\n');
  writeFileSync(join(root, "shared/index.ts"), "export const shared = true;\n");
  writeFileSync(join(root, "vendor/feature/package.json"), '{"name":"@acme/feature"}\n');
  writeFileSync(join(root, "vendor/feature/index.ts"), 'export type { Public } from "@acme/transitive";\n');
  writeFileSync(join(root, "node_modules/@acme/transitive/package.json"), '{"name":"@acme/transitive","types":"index.d.ts"}\n');
  writeFileSync(join(root, "node_modules/@acme/transitive/index.d.ts"), 'import type { Nested } from "./nested.d.ts"; export type Public = Nested;\n');
  writeFileSync(join(root, "node_modules/@acme/transitive/nested.d.ts"), "export interface Nested { value: number }\n");
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
    applications: [{ name: "web", sourceRoot: "apps/web/src", consumerRoots: ["apps/web/consumers"], tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], firstPartyRoots: ["shared"], firstPartyPackages: [{ root: "vendor/feature", name: "@acme/feature" }],
    packageManager: "bun", scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const options = { config, configPath, rootDir: root };
  const target = join(root, "apps/web/src/main.ts");
  const consumer = join(root, "apps/web/consumers/check.ts");
  const targetBytes = readFileSync(target);
  const consumerBytes = readFileSync(consumer);
  const inventory = captureInputInventory(options);
  expect(inventory.entries).toContainEqual(expect.objectContaining({ namespace: "installed", path: "node_modules/@acme/transitive/nested.d.ts", kind: "file" }));

  writeFileSync(join(root, "node_modules/@acme/transitive/nested.d.ts"), "export interface Nested { value: string }\n");
  expect(readFileSync(target)).toEqual(targetBytes);
  expect(readFileSync(consumer)).toEqual(consumerBytes);
  expect(() => verifyInputInventory(options, inventory)).toThrow(InputInventoryError);
});

test("unnamed external inputs with the same basename retain distinct inventory identities", () => {
  const root = scratchDirectory();
  const firstRoot = scratchDirectory();
  const secondRoot = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(root, "monocarve.config.json"), "{}\n");
  const first = join(firstRoot, "shared.d.ts");
  const second = join(secondRoot, "shared.d.ts");
  const identicalBytes = "export type Shared = 1;\n";
  writeFileSync(first, identicalBytes);
  writeFileSync(second, identicalBytes);
  symlinkSync(first, join(root, "apps/web/src/first.d.ts"));
  symlinkSync(second, join(root, "apps/web/src/second.d.ts"));
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
  const inventory = captureInputInventory({ config, configPath: join(root, "monocarve.config.json"), rootDir: root });
  const canonicalPaths = inventory.entries
    .filter((entry) => entry.namespace === "repository" && entry.kind === "symlink")
    .flatMap((entry) => entry.kind === "symlink" ? [entry.canonicalPath] : []);
  expect(canonicalPaths).toHaveLength(2);
  expect(new Set(canonicalPaths).size).toBe(2);
  expect(canonicalPaths.every((path) => !path.includes(firstRoot) && !path.includes(secondRoot))).toBeTrue();

  const uncapturedRoot = scratchDirectory();
  const uncaptured = join(uncapturedRoot, "shared.d.ts");
  writeFileSync(uncaptured, identicalBytes);
  const uncapturedReport = canonicalizeScanReport(root, {
    modules: [{ source: uncaptured, dependencies: [] }], observedReads: [uncaptured],
  });
  expect(() => assertReportsBoundToInventory(root, inventory, {
    web: uncapturedReport,
  })).toThrow(InputInventoryError);

  const missingFirst = join(firstRoot, "missing.json");
  const missingSecond = join(secondRoot, "missing.json");
  expect(canonicalInputPath(root, missingFirst)).not.toBe(canonicalInputPath(root, missingSecond));
  expect(canonicalInputPath(root, missingFirst)).not.toContain(firstRoot);
  expect(canonicalInputPath(root, missingSecond)).not.toContain(secondRoot);
  expect(() => assertReportsBoundToInventory(root, inventory, {
    web: { modules: [], observedReads: [canonicalInputPath(root, missingFirst)] },
  })).toThrow(InputInventoryError);
  expect(JSON.stringify(inventory)).not.toContain(firstRoot);
  expect(JSON.stringify(inventory)).not.toContain(secondRoot);
});

test("external input identities survive relocating the same checkout layout", () => {
  const first = scratchDirectory();
  const second = scratchDirectory();
  for (const base of [first, second]) {
    mkdirSync(join(base, "checkout"), { recursive: true });
    mkdirSync(join(base, "deps/@acme/shared"), { recursive: true });
    writeFileSync(join(base, "deps/@acme/shared/package.json"), '{"name":"@acme/shared"}\n');
    writeFileSync(join(base, "deps/@acme/shared/index.d.ts"), "export type Value = number;\n");
  }
  const firstPath = join(first, "deps/@acme/shared/index.d.ts");
  const secondPath = join(second, "deps/@acme/shared/index.d.ts");
  expect(canonicalInputPath(join(first, "checkout"), firstPath)).toBe(canonicalInputPath(join(second, "checkout"), secondPath));
  expect(canonicalInputPath(join(first, "checkout"), firstPath)).not.toContain(first);
});
