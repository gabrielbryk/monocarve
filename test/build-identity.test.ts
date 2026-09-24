import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";

import { readFileSync } from "node:fs";
import { buildSourceRevision } from "../scripts/build-stamp.ts";
import { runtimeIdentity } from "../src/assessment/snapshot.ts";
import { TOOL_VERSION } from "../src/branding.ts";
import { compilerBuildIdentity, executableBuildIdentity, executableBuildIdentityFor, sourceTreeIntegrity } from "../src/build-identity.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, scratchDirectory, write } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

test("source integrity changes when same-version compiler source bytes change", () => {
  const root = fixtureRepo({ "source/compiler.ts": "export const behavior = 1;\n", "source/readme.md": "ignored\n" });
  const sourceRoot = resolve(root, "source");
  const before = sourceTreeIntegrity(sourceRoot);

  write(root, "source/readme.md", "still ignored\n");
  expect(sourceTreeIntegrity(sourceRoot)).toBe(before);
  write(root, "source/compiler.ts", "export const behavior = 2;\n");
  expect(sourceTreeIntegrity(sourceRoot)).not.toBe(before);
  const changed = sourceTreeIntegrity(sourceRoot);
  write(root, "source/nested/compiler.ts", "export const behavior = 2;\n");
  expect(sourceTreeIntegrity(sourceRoot)).not.toBe(changed);
});

test("source-mode identity is the canonical tool source digest and carries no invented revision", () => {
  const sourceRoot = resolve(import.meta.dir, "../src");
  expect(compilerBuildIdentity()).toEqual({ artifactIntegrity: sourceTreeIntegrity(sourceRoot) });
});

test("rich executable identity composes but never changes behavioral compiler identity", () => {
  const compiler = compilerBuildIdentity();
  expect(executableBuildIdentity()).toEqual({ schemaVersion: 1, semanticVersion: TOOL_VERSION, packagingMode: "source", compiler });
  expect(executableBuildIdentityFor("dist-source").compiler).toEqual(compiler);
  expect(executableBuildIdentityFor("standalone-bun").compiler).toEqual(compiler);
  expect(Object.keys(compiler).sort()).toEqual(["artifactIntegrity"]);
});

test("build revision is exact for Git sources and absent for source archives", () => {
  const repository = fixtureRepo({ "src/compiler.ts": "export const compiler = true;\n" });
  expect(buildSourceRevision(repository)).toBe(fixtureGit(repository, "rev-parse", "HEAD"));
  expect(buildSourceRevision(scratchDirectory())).toBeUndefined();
});

test("assessment runtime identity records installed versions rather than declared ranges", () => {
  const root = resolve(import.meta.dir, "..");
  const installed = (name: string): string =>
    (JSON.parse(readFileSync(resolve(root, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(runtimeIdentity().dependencies).toEqual({ "dependency-cruiser": installed("dependency-cruiser"), typescript: installed("typescript") });
  expect(runtimeIdentity().dependencies["dependency-cruiser"]).not.toBe(manifest.dependencies["dependency-cruiser"]);
  expect(runtimeIdentity().dependencies.typescript).not.toBe(manifest.dependencies.typescript);
});
