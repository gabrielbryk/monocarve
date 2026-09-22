import { describe, expect, test } from "bun:test";

import { moonAdapter } from "../src/adapters/moon.ts";

const workspace = (globs: readonly string[]) =>
  ["vcs:", "  client: git", "", "projects:", "  globs:", ...globs.map((glob) => `    - ${glob}`), "", "generator:", "  templates: []", ""].join("\n");

describe("moon project discovery coverage", () => {
  test("treats a project-file glob as covering its directory", () => {
    expect(moonAdapter.registerProject(workspace(["libs/*/moon.yml"]), "libs/new-package", "new-package")).toEqual({ kind: "already-satisfied" });
  });

  test("still rejects a package root outside every glob", () => {
    expect(moonAdapter.registerProject(workspace(["libs/*/moon.yml"]), "packages/new-package", "new-package")).toEqual({
      kind: "unmet-precondition",
      reason: "project discovery globs do not cover packages/new-package",
    });
  });

  test("still rejects a nested package root a single-segment glob cannot reach", () => {
    expect(moonAdapter.registerProject(workspace(["libs/*/moon.yml"]), "libs/group/new-package", "new-package")).toEqual({
      kind: "unmet-precondition",
      reason: "project discovery globs do not cover libs/group/new-package",
    });
  });
});
