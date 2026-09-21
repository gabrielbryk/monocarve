/**
 * A run disposes its own worktree in a `finally`, on success and on failure
 * alike. Nothing in the process survives `SIGKILL`, a crashed host or a closed
 * terminal, so the leftovers accumulate in a worktree root shared by every run
 * against the repository — including, possibly, one running right now.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { createWorktree, pruneWorktrees } from "../src/transaction/worktree.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, scratchDirectory } from "./support/fixture-repo.ts";

const FILES = { "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true }, null, 2)}\n` };
const HOUR = 3_600_000;

function age(path: string, milliseconds: number): void {
  const when = new Date(Date.now() - milliseconds);
  utimesSync(path, when, when);
}

afterEach(() => {
  cleanupFixtures();
});

describe("prune worktrees", () => {
  test("reclaims a worktree whose run was interrupted", async () => {
    const root = fixtureRepo(FILES);
    const worktreeRoot = scratchDirectory();
    const worktree = await createWorktree({
      rootDir: root, commit: fixtureGit(root, "rev-parse", "HEAD"), worktreeRoot, nodeModules: "none",
    });
    // No dispose: exactly what a killed process leaves behind.
    age(worktree.path, 2 * HOUR);

    const result = await pruneWorktrees(root, worktreeRoot, { minimumAgeMs: HOUR });

    expect(result.removed).toEqual([worktree.path]);
    expect(existsSync(worktree.path)).toBe(false);
    expect(fixtureGit(root, "worktree", "list")).not.toContain(worktree.path);
  }, 60_000);

  test("skips a worktree younger than the threshold, which may be a live run", async () => {
    const root = fixtureRepo(FILES);
    const worktreeRoot = scratchDirectory();
    const worktree = await createWorktree({
      rootDir: root, commit: fixtureGit(root, "rev-parse", "HEAD"), worktreeRoot, nodeModules: "none",
    });

    const result = await pruneWorktrees(root, worktreeRoot, { minimumAgeMs: HOUR });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([worktree.path]);
    expect(existsSync(worktree.path)).toBe(true);
    await worktree.dispose();
  }, 60_000);

  test("removes regardless of age when no threshold is given", async () => {
    const root = fixtureRepo(FILES);
    const worktreeRoot = scratchDirectory();
    const worktree = await createWorktree({
      rootDir: root, commit: fixtureGit(root, "rev-parse", "HEAD"), worktreeRoot, nodeModules: "none",
    });

    const result = await pruneWorktrees(root, worktreeRoot);

    expect(result.removed).toEqual([worktree.path]);
    expect(existsSync(worktree.path)).toBe(false);
  }, 60_000);

  test("reclaims a leftover directory that is no longer a registered worktree", async () => {
    const root = fixtureRepo(FILES);
    const worktreeRoot = scratchDirectory();
    const orphan = join(worktreeRoot, "simulation-orphaned");
    mkdirSync(orphan, { recursive: true });
    age(orphan, 2 * HOUR);

    const result = await pruneWorktrees(root, worktreeRoot, { minimumAgeMs: HOUR });

    expect(result.removed).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
  }, 60_000);

  test("is a no-op when the worktree root has never been created", async () => {
    const root = fixtureRepo(FILES);

    const result = await pruneWorktrees(root, join(scratchDirectory(), "absent"), { minimumAgeMs: HOUR });

    expect(result).toEqual({ removed: [], skipped: [] });
  }, 60_000);
});
