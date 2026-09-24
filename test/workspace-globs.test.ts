import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertEnumerableGlobs,
  globsCoverPackage,
  resolveWorkspacePackages,
} from "../src/adapters/workspace-globs.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

function packageAt(root: string, path: string, name: string): void {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "package.json"), `${JSON.stringify({ name })}\n`);
}

test("nested segment globs enumerate zero, one, and multiple packages deterministically", () => {
  const root = fixtureRepo({ "package.json": '{"name":"fixture"}\n' });
  packageAt(root, "apps/zeta/ui", "@acme/zeta-ui");
  packageAt(root, "apps/alpha/ui", "@acme/alpha-ui");
  mkdirSync(join(root, "apps/no-manifest/ui"), { recursive: true });

  expect(resolveWorkspacePackages(root, ["missing/*/ui"])).toEqual({ packages: [], unmatched: ["missing/*/ui"] });
  expect(resolveWorkspacePackages(root, ["apps/alpha/ui"])).toEqual({
    packages: [{ name: "@acme/alpha-ui", dir: "apps/alpha/ui" }],
    unmatched: [],
  });
  expect(resolveWorkspacePackages(root, ["apps/*/ui"])).toEqual({
    packages: [
      { name: "@acme/alpha-ui", dir: "apps/alpha/ui" },
      { name: "@acme/zeta-ui", dir: "apps/zeta/ui" },
    ],
    unmatched: [],
  });
});

test("overlapping declarations deduplicate roots and supported negations exclude them", () => {
  const root = fixtureRepo({ "package.json": '{"name":"fixture"}\n' });
  packageAt(root, "apps/alpha/ui", "@acme/alpha-ui");
  packageAt(root, "apps/beta/ui", "@acme/beta-ui");

  expect(resolveWorkspacePackages(root, ["apps/*/ui", "apps/alpha/ui", "!apps/beta/ui"]).packages).toEqual([
    { name: "@acme/alpha-ui", dir: "apps/alpha/ui" },
  ]);
  expect(globsCoverPackage(["apps/*/ui", "!apps/beta/ui"], "apps/alpha/ui")).toBeTrue();
  expect(globsCoverPackage(["apps/*/ui", "!apps/beta/ui"], "apps/beta/ui")).toBeFalse();
  expect(globsCoverPackage(["apps/*/ui"], "apps/alpha/other")).toBeFalse();
});

test("real and in-workspace symlink declarations deduplicate the physical package root", () => {
  const root = fixtureRepo({ "package.json": '{"name":"fixture"}\n' });
  packageAt(root, "packages/alpha", "@acme/alpha");
  symlinkSync("alpha", join(root, "packages/alias"));

  expect(resolveWorkspacePackages(root, ["packages/alpha", "packages/alias"])).toEqual({
    packages: [{ name: "@acme/alpha", dir: "packages/alpha" }],
    unmatched: [],
  });
});

test("unsupported and escaping workspace syntax is refused before filesystem access", () => {
  for (const pattern of ["packages/**", "apps/ui-*", "../outside/*", "/absolute/*", "apps/{one,two}"]) {
    expect(() => assertEnumerableGlobs([pattern], "bun")).toThrow(`bun workspace glob is not yet ported: ${pattern}`);
  }
  expect(() => assertEnumerableGlobs(["!**/dist/**"], "pnpm")).not.toThrow();
});
