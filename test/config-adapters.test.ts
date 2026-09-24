import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { moonAdapter, noneTaskRunner } from "../src/adapters/moon.ts";
import { LockfileError, pnpmAdapter } from "../src/adapters/pnpm.ts";
import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../src/adapters/registry.ts";
import { loadConfig } from "../src/config.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");
afterEach(cleanupFixtures);

describe("adapters", () => {
  /**
   * Byte-for-byte the shape pnpm 11 writes for a link-only workspace, which is
   * not the shape this suite used to assert. An importer that declares nothing
   * is written inline as `  root: {}` — never as a `dependencies: {}` mapping —
   * and there is no `packages:` key at all when nothing is fetched from a
   * registry. A stand-in lockfile in the tool's own dialect makes every splicer
   * test pass against a file pnpm would never produce.
   */
  const lockfile = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "  apps/web:",
    "    dependencies:",
    "      '@acme/logger':",
    "        specifier: workspace:*",
    "        version: link:../../libs/logger",
    "",
    "  libs/logger: {}",
    "",
  ].join("\n");

  test("the registry is the only place tool choice is branched on", async () => {
    const config = (await loadConfig({ cwd: FIXTURE })).config;
    expect(createPackageManagerAdapter(config).id).toBe("pnpm");
    expect(createTaskRunnerAdapter(config).id).toBe("moon");
    // A ported adapter is resolved, not refused. Without this line the loop
    // below would still pass if the registry had thrown for every manager.
    expect(createPackageManagerAdapter({ ...config, packageManager: "bun" }).id).toBe("bun");
    for (const packageManager of ["npm", "yarn"] as const) {
      expect(() => createPackageManagerAdapter({ ...config, packageManager })).toThrow(
        `not yet ported: adapters/registry: ${packageManager} package-manager adapter`,
      );
    }
    for (const taskRunner of ["nx", "turbo"] as const) {
      expect(() => createTaskRunnerAdapter({ ...config, taskRunner })).toThrow(`not yet ported: adapters/registry: ${taskRunner} task-runner adapter`);
    }
  });

  test("inserts an importer block at its sorted position and is idempotent", () => {
    const block = "  libs/chart: {}\n\n";
    const inserted = pnpmAdapter.insertImporter(lockfile, "libs/chart", block);
    expect(inserted.indexOf("  apps/web:")).toBeLessThan(inserted.indexOf("  libs/chart:"));
    expect(inserted.indexOf("  libs/chart:")).toBeLessThan(inserted.indexOf("  libs/logger:"));
    expect(pnpmAdapter.importerBlock(inserted, "libs/chart")).toBe(block);
    // Re-inserting is a no-op, which is what makes journal replay safe.
    expect(pnpmAdapter.insertImporter(inserted, "libs/chart", block)).toBe(inserted);
    expect(pnpmAdapter.lockfileImporterHash(inserted, "libs/chart")).toBe(hashText(block));
  });

  test("reads the inline importers pnpm writes, and does not fold them into their predecessor", () => {
    // The failure this pins is not "an inline importer is missing". It is that
    // the *previous* block absorbs every line an unrecognised entry occupies, so
    // `apps/web`'s block would run to the end of the section and replacing it
    // would rewrite `libs/logger` too.
    expect(pnpmAdapter.importerBlock(lockfile, ".")).toBe("  .: {}\n\n");
    expect(pnpmAdapter.importerBlock(lockfile, "libs/logger")).toBe("  libs/logger: {}\n\n");
    // Its own `link:../../libs/logger` version stays; the `libs/logger` *entry*
    // must not be inside it.
    expect(pnpmAdapter.importerBlock(lockfile, "apps/web")).not.toContain("\n  libs/logger");
    expect(pnpmAdapter.importerBlock(lockfile, "libs/nope")).toBeUndefined();

    // Sorted position is only findable if the surrounding entries are visible:
    // `apps/api` sorts before `apps/web`, and after the inline root importer.
    const inserted = pnpmAdapter.insertImporter(lockfile, "apps/api", "  apps/api: {}\n\n");
    expect(inserted.indexOf("  .: {}")).toBeLessThan(inserted.indexOf("  apps/api:"));
    expect(inserted.indexOf("  apps/api:")).toBeLessThan(inserted.indexOf("  apps/web:"));
  });

  test("expands an inline importer that gains a dependency, and refuses to expand one carrying anything", () => {
    const block = pnpmAdapter.importerBlock(lockfile, "libs/logger")!;
    const wired = pnpmAdapter.addBlockDependency(block, "@acme/chart", "workspace:*", "link:../chart");

    // `  libs/logger: {}` plus a `dependencies:` mapping under it is a key with
    // two values, which is not YAML. The key has to lose its inline map first.
    expect(wired).toBe(
      ["  libs/logger:", "    dependencies:", "      '@acme/chart':", "        specifier: workspace:*", "        version: link:../chart", "", ""].join("\n"),
    );
    expect(wired).not.toContain("{}");
    expect(pnpmAdapter.addBlockDependency(wired, "@acme/chart", "workspace:*", "link:../chart")).toBe(wired);
    // The expanded block still round-trips through the section it came from.
    expect(pnpmAdapter.importerBlock(pnpmAdapter.replaceImporter(lockfile, "libs/logger", wired), "libs/logger")).toBe(wired);

    // An inline value that is not the empty map is content, and making room for
    // a dependency by discarding it would lose a resolution silently.
    expect(() => pnpmAdapter.addBlockDependency("  libs/logger: [1]\n\n", "@acme/chart", "workspace:*", "link:../chart")).toThrow(
      "cannot expand an inline importer that is not empty",
    );
  });

  test("adds a dependency to an existing block in sorted order, once", () => {
    const block = pnpmAdapter.importerBlock(lockfile, "apps/web")!;
    const wired = pnpmAdapter.addBlockDependency(block, "@acme/chart", "workspace:*", "link:../../libs/chart");
    expect(wired.indexOf("'@acme/chart'")).toBeLessThan(wired.indexOf("'@acme/logger'"));
    expect(pnpmAdapter.addBlockDependency(wired, "@acme/chart", "workspace:*", "link:../../libs/chart")).toBe(wired);
    expect(pnpmAdapter.replaceImporter(lockfile, "apps/web", wired)).toContain("'@acme/chart'");
    expect(() => pnpmAdapter.replaceImporter(lockfile, "libs/nope", wired)).toThrow("no importer block to replace");
  });

  test("refuses a catalog dependency whose concrete lockfile resolutions disagree", () => {
    const divergent = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  apps/api:",
      "    dependencies:",
      "      left-pad:",
      "        specifier: 1.2.0",
      "        version: 1.2.0",
      "",
      "  apps/web:",
      "    dependencies:",
      "      left-pad:",
      "        specifier: 1.3.0",
      "        version: 1.3.0",
      "",
    ].join("\n");

    expect(() =>
      pnpmAdapter.renderImporterBlock({
        packageRoot: "libs/chart",
        dependencies: { "left-pad": "catalog:" },
        devDependencies: {},
        lockfileText: divergent,
        workspaceRoots: {},
      }),
    ).toThrow("lockfile resolves left-pad@catalog: to more than one version");
  });

  test("removes exactly one dependency and collapses an emptied importer", () => {
    const block = pnpmAdapter.addBlockDependency(pnpmAdapter.importerBlock(lockfile, "apps/web")!, "typescript", "^5.0.0", "5.0.0", "dev");
    const pruned = pnpmAdapter.removeBlockDependency(block, "@acme/logger");
    expect(pruned).not.toContain("@acme/logger");
    expect(pruned).toContain("typescript");
    expect(pnpmAdapter.removeBlockDependency(pruned, "absent")).toBe(pruned);

    const only = pnpmAdapter.addBlockDependency("  libs/solo: {}\n\n", "left-pad", "1.3.0", "1.3.0");
    expect(pnpmAdapter.removeBlockDependency(only, "left-pad")).toBe("  libs/solo: {}\n\n");
  });

  test("adds dev consumers in pnpm section order and promotes them when runtime also needs the package", () => {
    const inline = pnpmAdapter.addBlockDependency("  apps/web: {}\n\n", "@acme/chart", "workspace:*", "link:../../libs/chart", "dev");
    expect(inline).toContain("    devDependencies:");
    expect(inline).not.toContain("    dependencies:");
    expect(pnpmAdapter.addBlockDependency(inline, "@acme/chart", "workspace:*", "link:../../libs/chart", "dev")).toBe(inline);

    const devOnly = [
      "  apps/web:",
      "    devDependencies:",
      "      '@acme/chart':",
      "        specifier: workspace:*",
      "        version: link:../../libs/chart",
      "    optionalDependencies:",
      "      optional:",
      "        specifier: workspace:*",
      "        version: link:../../libs/optional",
      "",
      "",
    ].join("\n");
    const promoted = pnpmAdapter.addBlockDependency(devOnly, "@acme/chart", "workspace:*", "link:../../libs/chart");
    expect(promoted).toContain("    dependencies:");
    expect(promoted).not.toContain("    devDependencies:");
    expect(promoted.indexOf("    dependencies:")).toBeLessThan(promoted.indexOf("    optionalDependencies:"));
    expect(pnpmAdapter.addBlockDependency(promoted, "@acme/chart", "workspace:*", "link:../../libs/chart")).toBe(promoted);
  });

  test("refuses duplicate and optional importer dependency states instead of guessing a section", () => {
    const duplicate = [
      "  apps/web:",
      "    dependencies:",
      "      '@acme/chart':",
      "        specifier: workspace:*",
      "        version: link:../../libs/chart",
      "    devDependencies:",
      "      '@acme/chart':",
      "        specifier: workspace:*",
      "        version: link:../../libs/chart",
      "",
      "",
    ].join("\n");
    expect(() => pnpmAdapter.addBlockDependency(duplicate, "@acme/chart", "workspace:*", "link:../../libs/chart")).toThrow("more than one dependency section");
    const optional = duplicate
      .replace("    dependencies:", "    optionalDependencies:")
      .replace("    devDependencies:\n      '@acme/chart':\n        specifier: workspace:*\n        version: link:../../libs/chart", "");
    expect(() => pnpmAdapter.addBlockDependency(optional, "@acme/chart", "workspace:*", "link:../../libs/chart", "dev")).toThrow("optionalDependencies");
    const unfamiliar = [
      "  apps/web:",
      "    dependencies:",
      "      known:",
      "        specifier: workspace:*",
      "        version: link:../../libs/known",
      "    customDependencies:",
      "      '@acme/chart':",
      "        specifier: workspace:*",
      "        version: link:../../libs/chart",
      "",
      "",
    ].join("\n");
    expect(() => pnpmAdapter.addBlockDependency(unfamiliar, "@acme/chart", "workspace:*", "link:../../libs/chart")).toThrow(
      "unfamiliar importer mapping customDependencies:",
    );
  });

  test("renders an importer block from resolved versions, never invented ones", () => {
    const block = pnpmAdapter.renderImporterBlock({
      packageRoot: "libs/chart",
      dependencies: { "@acme/logger": "workspace:*" },
      devDependencies: {},
      lockfileText: lockfile,
      workspaceRoots: { "@acme/logger": "libs/logger" },
    });
    expect(block).toContain("  libs/chart:");
    expect(block).toContain("      '@acme/logger':");
    expect(block).toContain("        version: link:../logger");
    // A package that declares nothing is inline, because that is what pnpm
    // writes for one; `  libs/chart:` alone is YAML null, not an empty map.
    expect(
      pnpmAdapter.renderImporterBlock({ packageRoot: "libs/chart", dependencies: {}, devDependencies: {}, lockfileText: lockfile, workspaceRoots: {} }),
    ).toBe("  libs/chart: {}");
    // An exact pin is not self-attesting. This lockfile carries no packages:
    // or snapshots: entry for it, so writing `version: 1.0.0` would name a
    // resolution nothing in the file backs — bytes pnpm re-serializes
    // unchanged and `--frozen-lockfile` then refuses. Only the lockfile may
    // resolve a version, so this refuses instead of inventing one.
    expect(() =>
      pnpmAdapter.renderImporterBlock({
        packageRoot: "libs/chart",
        dependencies: { pinned: "1.0.0" },
        devDependencies: {},
        lockfileText: lockfile,
        workspaceRoots: {},
      }),
    ).toThrow("cannot resolve a lockfile version");
    // A range that no importer already resolved cannot be invented.
    expect(() =>
      pnpmAdapter.renderImporterBlock({
        packageRoot: "libs/chart",
        dependencies: { unknown: "catalog:" },
        devDependencies: {},
        lockfileText: lockfile,
        workspaceRoots: {},
      }),
    ).toThrow("cannot resolve a lockfile version");
  });

  /**
   * A dependency resolved by two importers, with a third importer's block to be
   * rendered from one of their resolutions. `pluggable` is external, so it takes
   * the copy-an-existing-resolution path rather than the `workspace:` link path;
   * the peer-dependency suffix is what makes two importers disagree in practice.
   */
  const disagreeing = (left: string, right: string): string =>
    [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
      "  apps/admin:",
      "    dependencies:",
      "      pluggable:",
      "        specifier: ^1.0.0",
      `        version: ${left}`,
      "",
      "  apps/web:",
      "    dependencies:",
      "      pluggable:",
      "        specifier: ^1.0.0",
      `        version: ${right}`,
      "",
    ].join("\n");

  test("refuses to pick between importers that resolved the same specifier differently", () => {
    // The failure this pins is silent, which is why it needs pinning: with two
    // resolutions in the section the renderer took whichever came first in the
    // file and wrote it into a new package's block. Document order is not a
    // decision about which peer a new package should build against, and the
    // adapter has no basis for making that decision — the same reason it throws
    // for a dependency no importer has resolved at all.
    const render = (lockfileText: string): string =>
      pnpmAdapter.renderImporterBlock({
        packageRoot: "libs/chart",
        dependencies: { pluggable: "^1.0.0" },
        devDependencies: {},
        lockfileText,
        workspaceRoots: {},
      });

    let thrown: unknown;
    try {
      render(disagreeing("1.0.0(react@17.0.0)", "1.0.0(react@18.0.0)"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LockfileError);
    const message = (thrown as Error).message;
    // A human reconciling this needs all four facts: what, at which range, to
    // which versions, and where each one came from.
    expect(message).toContain("pluggable@^1.0.0");
    expect(message).toContain("1.0.0(react@17.0.0)");
    expect(message).toContain("1.0.0(react@18.0.0)");
    expect(message).toContain("apps/admin");
    expect(message).toContain("apps/web");

    // Agreement is not ambiguity: the common case must still resolve, and must
    // resolve to the version both importers actually hold.
    expect(render(disagreeing("1.0.0(react@18.0.0)", "1.0.0(react@18.0.0)"))).toContain("        version: 1.0.0(react@18.0.0)");

    // One importer is still one answer — including when it is the last entry in
    // the section, where the scan has no following entry to stop at.
    const single = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
      "  apps/web:",
      "    dependencies:",
      "      pluggable:",
      "        specifier: ^1.0.0",
      "        version: 1.0.0(react@18.0.0)",
      "",
    ].join("\n");
    expect(render(single)).toContain("        version: 1.0.0(react@18.0.0)");
  });

  test("projects an existing importer from its own peer-context resolution", () => {
    const lockfileText = disagreeing("1.0.0(react@17.0.0)", "1.0.0(react@18.0.0)");
    const block = pnpmAdapter.renderImporterBlock({
      packageRoot: "apps/admin",
      dependencies: { pluggable: "^1.0.0" },
      devDependencies: {},
      lockfileText,
      workspaceRoots: {},
    });

    expect(block).toContain("        version: 1.0.0(react@17.0.0)");
    expect(block).not.toContain("        version: 1.0.0(react@18.0.0)");
  });

  test("projects a new importer from its donating importer resolution", () => {
    const lockfileText = disagreeing("1.0.0(react@17.0.0)", "1.0.0(react@18.0.0)");
    const block = pnpmAdapter.renderImporterBlock({
      packageRoot: "libs/chart",
      dependencies: { pluggable: "^1.0.0" },
      devDependencies: {},
      lockfileText,
      workspaceRoots: {},
      resolutionRoots: { pluggable: ["apps/admin"] },
    });

    expect(block).toContain("        version: 1.0.0(react@17.0.0)");
    expect(block).not.toContain("        version: 1.0.0(react@18.0.0)");
  });

  test("projects a new catalog importer from its donating importer resolution", () => {
    const lockfileText = disagreeing("1.0.0(react@17.0.0)", "1.0.0(react@18.0.0)").replaceAll("specifier: ^1.0.0", "specifier: catalog:");
    const block = pnpmAdapter.renderImporterBlock({
      packageRoot: "libs/chart",
      dependencies: {},
      devDependencies: { pluggable: "catalog:" },
      lockfileText,
      workspaceRoots: {},
      resolutionRoots: { pluggable: ["apps/admin"] },
    });

    expect(block).toContain("specifier: 'catalog:'");
    expect(block).toContain("        version: 1.0.0(react@17.0.0)");
    expect(block).not.toContain("        version: 1.0.0(react@18.0.0)");
  });

  test("refuses a new importer whose owner contexts disagree", () => {
    const lockfileText = disagreeing("1.0.0(react@17.0.0)", "1.0.0(react@18.0.0)");

    expect(() =>
      pnpmAdapter.renderImporterBlock({
        packageRoot: "libs/chart",
        dependencies: { pluggable: "^1.0.0" },
        devDependencies: {},
        lockfileText,
        workspaceRoots: {},
        resolutionRoots: { pluggable: ["apps/admin", "apps/web"] },
      }),
    ).toThrow("lockfile resolves pluggable@^1.0.0 to more than one version");
  });

  test("projects an existing catalog importer from its own peer-context resolution", () => {
    const lockfileText = disagreeing("1.0.0(react@17.0.0)", "1.0.0(react@18.0.0)").replaceAll("specifier: ^1.0.0", "specifier: catalog:");
    const block = pnpmAdapter.renderImporterBlock({
      packageRoot: "apps/admin",
      dependencies: { pluggable: "catalog:" },
      devDependencies: {},
      lockfileText,
      workspaceRoots: {},
    });

    expect(block).toContain("        version: 1.0.0(react@17.0.0)");
    expect(block).not.toContain("        version: 1.0.0(react@18.0.0)");
  });

  test("edits workspace membership only when the globs do not already cover it", () => {
    const manifest = "packages:\n  - apps/*\n  - libs/*\n";
    expect(pnpmAdapter.workspaceManifestEdit(manifest, "libs/chart")).toEqual({ kind: "already-satisfied" });
    expect(pnpmAdapter.workspaceManifestEdit(manifest, "vendor/chart")).toMatchObject({
      kind: "changed",
      contents: expect.stringContaining("  - vendor/chart"),
    });
  });

  test("supports negated workspace globs while refusing positive shapes it cannot enumerate", async () => {
    const inline = fixtureRepo({ "pnpm-workspace.yaml": "packages: ['libs/*']\n" });
    await expect(pnpmAdapter.listPackages(inline)).rejects.toThrow("inline pnpm workspace package arrays are not yet ported");

    const nested = fixtureRepo({ "pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n" });
    await expect(pnpmAdapter.listPackages(nested)).rejects.toThrow("workspace glob is not yet ported");

    const supportedNested = fixtureRepo({ "pnpm-workspace.yaml": "packages:\n  - 'apps/*/ui'\n" });
    for (const [dir, name] of [
      ["apps/one/ui", "@acme/one-ui"],
      ["apps/two/ui", "@acme/two-ui"],
    ] as const) {
      mkdirSync(join(supportedNested, dir), { recursive: true });
      writeFileSync(join(supportedNested, dir, "package.json"), JSON.stringify({ name }));
    }
    await expect(pnpmAdapter.listPackages(supportedNested)).resolves.toEqual([
      { name: "@acme/one-ui", dir: "apps/one/ui" },
      { name: "@acme/two-ui", dir: "apps/two/ui" },
    ]);

    const excluded = fixtureRepo({ "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n  - '!**/dist/**'\n" });
    const excludedPackages: Array<[string, string]> = [
      ["libs/kept", "@acme/kept"],
      ["libs/dist", "@acme/excluded"],
    ];
    for (const [dir, name] of excludedPackages) {
      mkdirSync(join(excluded, dir), { recursive: true });
      writeFileSync(join(excluded, dir, "package.json"), JSON.stringify({ name }));
    }
    await expect(pnpmAdapter.listPackages(excluded)).resolves.toEqual([{ name: "@acme/kept", dir: "libs/kept" }]);

    const duplicate = fixtureRepo({ "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n" });
    for (const dir of ["libs/one", "libs/two"]) {
      mkdirSync(join(duplicate, dir), { recursive: true });
      writeFileSync(join(duplicate, dir, "package.json"), '{"name":"@acme/duplicate"}\n');
    }
    await expect(pnpmAdapter.listPackages(duplicate)).rejects.toThrow("declared by both libs/one and libs/two");
  });

  test("moon reads a declared project id and registers explicit projects in order", () => {
    expect(moonAdapter.projectIdFor("@acme/chart", "libs/chart")).toBe("chart");
    expect(moonAdapter.projectIdOf(FIXTURE, "libs/format")).toBe("format");
    expect(moonAdapter.wrapGateCommand("moon run chart:test")).toEqual(["sh", "-c", "moon run chart:test"]);

    // Glob-based discovery needs no registration at all.
    expect(moonAdapter.registerProject("projects:\n  globs:\n    - 'libs/*'\n", "libs/chart", "chart")).toEqual({ kind: "already-satisfied" });

    const explicit = "projects:\n  api: 'apps/api'\n  logger: 'libs/logger'\n";
    const registered = moonAdapter.registerProject(explicit, "libs/chart", "chart");
    expect(registered.kind).toBe("changed");
    if (registered.kind === "changed") {
      expect(registered.contents).toContain("  chart: 'libs/chart'");
      expect(registered.contents.indexOf("chart:")).toBeLessThan(registered.contents.indexOf("logger:"));
      expect(moonAdapter.registerProject(registered.contents, "libs/chart", "chart")).toEqual({ kind: "already-satisfied" });
    }
    expect(moonAdapter.registerProject("projects:\n  globs:\n    - 'apps/*'\n", "libs/chart", "chart")).toEqual({
      kind: "unmet-precondition",
      reason: "project discovery globs do not cover libs/chart",
    });
    expect(
      moonAdapter.registerProject("projects:\n  globs:\n    - 'apps/*'\nother:\n  globs:\n    - 'libs/*'\n  chart: 'libs/chart'\n", "libs/chart", "chart"),
    ).toEqual({ kind: "unmet-precondition", reason: "project discovery globs do not cover libs/chart" });
    expect(
      moonAdapter.registerProject(
        "projects:\n  api: 'apps/api'\n# Existing projects stay sorted by id.\n  chart: 'libs/chart'\nother:\n  enabled: true\n",
        "libs/chart",
        "chart",
      ),
    ).toEqual({ kind: "already-satisfied" });

    expect(noneTaskRunner.projectIdFor("@acme/chart", "libs/chart")).toBe("@acme/chart");
    expect(noneTaskRunner.registerProject("", "libs/chart", "chart")).toEqual({ kind: "already-satisfied" });
  });
});
