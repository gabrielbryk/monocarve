import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";

import { buildSourceRevision } from "../scripts/build-stamp.ts";
import { compilerBuildIdentity, sourceTreeIntegrity } from "../src/build-identity.ts";
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

test("build revision is exact for Git sources and absent for source archives", () => {
  const repository = fixtureRepo({ "src/compiler.ts": "export const compiler = true;\n" });
  expect(buildSourceRevision(repository)).toBe(fixtureGit(repository, "rev-parse", "HEAD"));
  expect(buildSourceRevision(scratchDirectory())).toBeUndefined();
});
