import { afterAll, describe, expect, test } from "bun:test";

import { refreshCommittedDependencies } from "../src/transaction/apply.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

describe("committed dependency refresh", () => {
  afterAll(cleanupFixtures);

  test("runs the adapter install command for install-mode checkouts", () => {
    const root = fixtureRepo({ "README.md": "fixture\n" });
    const config = fixtureConfig(root, { transaction: { worktreeRoot: ".scratch", nodeModules: "install", cleanup: true } });
    const observed: { root?: string; command?: readonly string[] } = {};

    const evidence = refreshCommittedDependencies(config, root, (nextRoot, command) => {
      observed.root = nextRoot;
      observed.command = command;
    });

    expect(observed).toEqual({ root, command: ["pnpm", "install", "--frozen-lockfile"] });
    expect(evidence).toEqual({ mode: "install", command: ["pnpm", "install", "--frozen-lockfile"], completed: true });
  });

  test("does not install for symlink or none policies", () => {
    for (const nodeModules of ["symlink", "none"] as const) {
      const root = fixtureRepo({ "README.md": "fixture\n" });
      const config = fixtureConfig(root, { transaction: { worktreeRoot: ".scratch", nodeModules, cleanup: true } });
      let called = false;
      refreshCommittedDependencies(config, root, () => {
        called = true;
      });
      expect(called).toBe(false);
    }
  });
});
