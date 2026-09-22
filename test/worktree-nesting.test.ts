/**
 * A linked worktree is a complete checkout of its own. Simulation worktrees
 * created beneath one look like nested worktrees on disk, make discovery tools
 * recurse through every checkout, and leave the owning checkout unusable while
 * its contents are being removed. `createWorktree` refuses such a destination;
 * the primary worktree stays the one exception, so a repo-relative
 * `.worktrees/...` root still resolves normally.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createWorktree } from "../src/transaction/worktree.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo } from "./support/fixture-repo.ts";

const FILES = { "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n` };

afterEach(() => {
  cleanupFixtures();
});

describe("simulation worktree nesting", () => {
  test("refuses a worktreeRoot inside a linked worktree", async () => {
    const root = fixtureRepo(FILES);
    const head = fixtureGit(root, "rev-parse", "HEAD");
    const linked = join(root, ".worktrees", "linked-checkout");
    const nested = join(linked, ".worktrees", "monocarve-worktrees");
    fixtureGit(root, "worktree", "add", "--detach", linked, head);

    try {
      await expect(createWorktree({ rootDir: root, commit: head, worktreeRoot: nested, nodeModules: "none" })).rejects.toThrow(/inside registered worktree/);
      expect(existsSync(nested)).toBe(false);
    } finally {
      fixtureGit(root, "worktree", "remove", "--force", linked);
    }
  }, 60_000);

  test("accepts a worktreeRoot inside the primary worktree", async () => {
    const root = fixtureRepo(FILES);
    const head = fixtureGit(root, "rev-parse", "HEAD");

    const worktree = await createWorktree({ rootDir: root, commit: head, worktreeRoot: ".worktrees/scratch", nodeModules: "none" });

    expect(existsSync(worktree.path)).toBe(true);
    await worktree.dispose();
  }, 60_000);
});
