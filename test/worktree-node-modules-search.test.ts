/**
 * The `symlink` strategy mirrors every `node_modules` in the checkout into the
 * disposable worktree. Which directories it looks in is the whole question:
 * too few and a package silently loses its dependencies inside the simulation,
 * too many and every run walks the entire repository to find a handful of hits.
 *
 * `packageRoots` bounds the search to the configured package-container
 * subtrees. These tests pin both halves of that bargain — arbitrary depth
 * *within* a container, nothing at all outside one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { packageContainerRoots } from "../src/config.ts";
import { createWorktree } from "../src/transaction/worktree.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, scratchDirectory } from "./support/fixture-repo.ts";

const NESTED = "libs/shared/deeply/contracts";
const OUTSIDE = "docs/examples/sample";

function files(): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "apps/api/package.json": `${JSON.stringify({ name: "@acme/api", version: "0.1.0", private: true })}\n`,
    [`${NESTED}/package.json`]: `${JSON.stringify({ name: "@acme/contracts", version: "0.1.0", private: true })}\n`,
    [`${OUTSIDE}/package.json`]: `${JSON.stringify({ name: "sample-doc", version: "0.1.0", private: true })}\n`,
  };
}

/** A pnpm-shaped install: a real directory in a store, reached by a symlink. */
function installPackage(root: string, owner: string, name: string): string {
  const store = join(root, "node_modules", ".store", `${name}@1.0.0`, "node_modules", name);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`);
  const link = join(root, owner, "node_modules", name);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(store, link, "dir");
  return realpathSync(store);
}

afterEach(() => {
  cleanupFixtures();
});

describe("simulation worktree node_modules search", () => {
  test("packageContainerRoots names the container subtrees without scanning sources", () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root);

    // `apps/api` is the application owner derived from `apps/api/src`; `libs`
    // is the configured package root. `docs` is neither.
    expect(packageContainerRoots(config)).toEqual(["apps/api", "libs"]);
  });

  test("finds a package nested arbitrarily deep inside a container root", async () => {
    const root = fixtureRepo(files());
    // After the fixture commit, so `node_modules` is untracked and cannot reach
    // the worktree through the checkout — only through the mirroring.
    const store = installPackage(root, NESTED, "left-pad");

    const worktree = await createWorktree({
      rootDir: root,
      commit: fixtureGit(root, "rev-parse", "HEAD"),
      worktreeRoot: scratchDirectory(),
      nodeModules: "symlink",
      packageRoots: packageContainerRoots(fixtureConfig(root)),
    });

    // Four levels below the repo root — past any plausible depth limit.
    expect(realpathSync(join(worktree.workspacePath, NESTED, "node_modules", "left-pad"))).toBe(store);
    await worktree.dispose();
  }, 60_000);

  test("does not mirror node_modules outside the container roots", async () => {
    const root = fixtureRepo(files());
    installPackage(root, OUTSIDE, "left-pad");

    const worktree = await createWorktree({
      rootDir: root,
      commit: fixtureGit(root, "rev-parse", "HEAD"),
      worktreeRoot: scratchDirectory(),
      nodeModules: "symlink",
      packageRoots: packageContainerRoots(fixtureConfig(root)),
    });

    expect(existsSync(join(worktree.workspacePath, OUTSIDE, "node_modules"))).toBe(false);
    await worktree.dispose();
  }, 60_000);
});
