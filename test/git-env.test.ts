/**
 * The git environment scrub.
 *
 * `GIT_INDEX_FILE`, `GIT_DIR`, and `GIT_WORK_TREE` are inherited by every child
 * process. When this tool runs under a git hook — or a test suite does — those
 * variables point at a *different* repository than `cwd` does, and a `git add`
 * that inherits them writes into that other repository's index. It looks like
 * it worked. It destroys staged work silently.
 *
 * So every git invocation in `src/` and in the test harness goes through a
 * scrubbed environment, and these tests hold that property in place: one that
 * checks the scrub itself, and one that poisons the environment and proves a
 * fixture commit did not touch the poisoned index.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, scrubbedGitEnv } from "../src/util/git.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, scratchDirectory, write } from "./support/fixture-repo.ts";

describe("git environment", () => {
  afterEach(cleanupFixtures);

  test("removes every repository-redirecting variable", () => {
    const env = scrubbedGitEnv({
      PATH: "/usr/bin",
      GIT_INDEX_FILE: "/somewhere/else/index",
      GIT_DIR: "/somewhere/else/.git",
      GIT_WORK_TREE: "/somewhere/else",
      GIT_AUTHOR_NAME: "kept",
    });
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    // Only the redirecting variables go: identity and config still apply.
    expect(env.GIT_AUTHOR_NAME).toBe("kept");
  });

  test("a fixture commit ignores a poisoned GIT_INDEX_FILE", () => {
    const poisonedIndex = join(scratchDirectory(), "poisoned-index");
    writeFileSync(poisonedIndex, "");
    const before = statSync(poisonedIndex).size;

    const previous = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = poisonedIndex;
    try {
      const root = fixtureRepo({ "file.ts": "export const value = 1;\n" });
      write(root, "second.ts", "export const other = 2;\n");
      fixtureGit(root, "add", "-A");
      fixtureGit(root, "commit", "-qm", "test: second file");

      expect(fixtureGit(root, "log", "--format=%s").split("\n")).toContain("test: second file");
      expect(existsSync(join(root, "second.ts"))).toBe(true);
      // The poisoned index was never written to: git used the repository at cwd.
      expect(statSync(poisonedIndex).size).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
    }
  });

  test("fixture identity is local and cannot fall through to an enclosing repository", () => {
    const host = fixtureRepo({ "host.ts": "export const host = true;\n" });
    fixtureGit(host, "config", "user.name", "Host Repository");
    fixtureGit(host, "config", "user.email", "host@example.invalid");
    const hostConfig = join(host, ".git", "config");
    const before = readFileSync(hostConfig, "utf8");

    // This is the plausible old failure: an invalid fixture root nested in a
    // repository made plain `git config` discover and modify the enclosing
    // repository. A helper that merely sets cwd cannot distinguish that from a
    // valid fixture. The pinned git-dir must refuse before any write occurs.
    const notARepository = join(host, "nested", "not-a-repository");
    mkdirSync(notARepository, { recursive: true });
    expect(() => fixtureGit(notARepository, "config", "user.name", "Leaked Fixture Identity")).toThrow(
      "fixture repository does not exist",
    );
    expect(readFileSync(hostConfig, "utf8")).toBe(before);
    expect(fixtureGit(host, "config", "--local", "--get", "user.name")).toBe("Host Repository");
    expect(() => fixtureGit(host, "config", "--global", "user.name", "Leaked Global Identity")).toThrow(
      "fixture git config may not use --global",
    );
    expect(readFileSync(hostConfig, "utf8")).toBe(before);
    expect(() => fixtureGit(host, "--no-pager", "config", "--global", "user.name", "Leaked Global Identity")).toThrow(
      "fixture git config may not use --global",
    );
    expect(readFileSync(hostConfig, "utf8")).toBe(before);

    const fixture = fixtureRepo({ "fixture.ts": "export const fixture = true;\n" });
    fixtureGit(fixture, "--no-pager", "config", "fixture.prefixed", "true");
    expect(fixtureGit(fixture, "config", "--local", "--get", "fixture.prefixed")).toBe("true");
    expect(() => fixtureGit(fixture, "--git-dir", join(host, ".git"), "config", "user.name", "Leaked Host Identity")).toThrow(
      "fixture git may not use repository or config selector --git-dir",
    );
    expect(readFileSync(hostConfig, "utf8")).toBe(before);

    expect(fixtureGit(fixture, "log", "-1", "--format=%an <%ae>")).toBe("Monocarve Fixture <fixture@example.invalid>");
  });

  test("fixture commands use a linked worktree's actual git directory", () => {
    const primary = fixtureRepo({ "primary.ts": "export const primary = true;\n" });
    const linked = join(scratchDirectory(), "linked");
    fixtureGit(primary, "worktree", "add", "-q", "-b", "linked-fixture", linked);

    fixtureGit(linked, "config", "user.name", "Linked Fixture");
    fixtureGit(linked, "config", "user.email", "linked@example.invalid");
    write(linked, "linked.ts", "export const linked = true;\n");
    fixtureGit(linked, "add", "--", "linked.ts");
    fixtureGit(linked, "commit", "-qm", "test: commit from linked fixture");

    expect(fixtureGit(linked, "log", "-1", "--format=%an <%ae>")).toBe("Linked Fixture <linked@example.invalid>");
    expect(fixtureGit(primary, "log", "-1", "--format=%s")).toBe("test: seed extraction fixture");
  });

  test("fixture init cannot place its metadata outside the fixture", () => {
    const scratch = scratchDirectory();
    const root = join(scratch, "fixture");
    const externalGitDir = join(scratch, "external-git-dir");
    mkdirSync(root);

    expect(() => fixtureGit(root, "init", "--separate-git-dir", externalGitDir)).toThrow(
      "fixture git init may not use --separate-git-dir",
    );
    expect(existsSync(externalGitDir)).toBe(false);
    expect(existsSync(join(root, ".git"))).toBe(false);

    const prefixed = join(scratch, "prefixed-fixture");
    mkdirSync(prefixed);
    fixtureGit(prefixed, "--no-pager", "init", "-q");
    expect(existsSync(join(prefixed, ".git"))).toBe(true);
  });

  test("the engine's own git helper ignores a poisoned GIT_INDEX_FILE", () => {
    const poisonedIndex = join(scratchDirectory(), "engine-poisoned-index");
    writeFileSync(poisonedIndex, "");
    const before = statSync(poisonedIndex).size;

    const previous = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = poisonedIndex;
    try {
      const root = fixtureRepo({ "file.ts": "export const value = 1;\n" });
      write(root, "third.ts", "export const third = 3;\n");
      git({ cwd: root, quiet: true }, "add", "-A");
      git({ cwd: root, quiet: true }, "commit", "-m", "test: engine commit");

      expect(git({ cwd: root }, "log", "-1", "--format=%s")).toBe("test: engine commit");
      expect(statSync(poisonedIndex).size).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
    }
  });
});
