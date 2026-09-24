/**
 * `configDigest` binds a plan to the configuration it was compiled against, so
 * what it does NOT cover is as load-bearing as what it does.
 *
 * `transaction.worktreeRoot` is where this host happens to build disposable
 * simulation worktrees. Including it made a plan's identity depend on the
 * filesystem of the machine that compiled it: two developers with different
 * TMPDIR computed different digests for the same plan, and moving the default
 * scratch root made a freshly compiled plan fail validation as forged with
 * "plan configuration digest does not match the effective configuration".
 */
import { afterEach, describe, expect, test } from "bun:test";

import { configDigest } from "../src/config/digest.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

const FILES = { "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true }, null, 2)}\n` };

afterEach(() => {
  cleanupFixtures();
});

describe("plan configuration digest", () => {
  test("ignores the machine-local worktree root", () => {
    const root = fixtureRepo(FILES);
    const here = fixtureConfig(root, { transaction: { worktreeRoot: "/tmp/scratch-a", nodeModules: "none", cleanup: true, simulateGates: false } });
    const elsewhere = fixtureConfig(root, { transaction: { worktreeRoot: "/var/tmp/scratch-b", nodeModules: "none", cleanup: true, simulateGates: false } });

    expect(configDigest(here)).toBe(configDigest(elsewhere));
  });

  test("still covers other transaction settings", () => {
    // Only the scratch path is exempt. A different simulation strategy is a
    // real difference in how the plan was proven.
    const root = fixtureRepo(FILES);
    const linked = fixtureConfig(root, { transaction: { worktreeRoot: "/tmp/scratch", nodeModules: "symlink", cleanup: true, simulateGates: false } });
    const installed = fixtureConfig(root, { transaction: { worktreeRoot: "/tmp/scratch", nodeModules: "install", cleanup: true, simulateGates: false } });

    expect(configDigest(linked)).not.toBe(configDigest(installed));
  });

  test("still covers configuration that changes what a plan means", () => {
    const root = fixtureRepo(FILES);
    const libs = fixtureConfig(root, { packageRoots: ["libs"] });
    const packages = fixtureConfig(root, { packageRoots: ["packages"] });

    expect(configDigest(libs)).not.toBe(configDigest(packages));
  });
});
