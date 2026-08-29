/**
 * The bun adapter's grammar, against bun's own bytes.
 *
 * The lockfile below is what `bun install --lockfile-only` wrote for a
 * four-member workspace, copied verbatim. That matters more here than it does
 * for a YAML adapter: `bun.lock` is JSONC whose *formatting* is part of the
 * format — trailing commas, the blank line between `packages` entries, the
 * order of the dependency maps — so a stand-in written in the tool's own
 * dialect would let every splice pass while producing a file bun rewrites.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bunAdapter, LockfileError } from "../src/adapters/bun.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

const lockfile = [
  "{",
  '  "lockfileVersion": 1,',
  '  "configVersion": 1,',
  '  "workspaces": {',
  '    "": {',
  '      "name": "fixture-workspace",',
  "    },",
  '    "apps/api": {',
  '      "name": "@acme/api",',
  '      "version": "0.0.0",',
  "    },",
  '    "apps/web": {',
  '      "name": "@acme/web",',
  '      "version": "0.0.0",',
  '      "dependencies": {',
  '        "@acme/logger": "workspace:*",',
  '        "left-pad": "1.3.0",',
  "      },",
  '      "devDependencies": {',
  '        "@acme/format": "workspace:*",',
  "      },",
  "    },",
  '    "libs/format": {',
  '      "name": "@acme/format",',
  '      "version": "0.0.0",',
  "    },",
  '    "libs/logger": {',
  '      "name": "@acme/logger",',
  '      "version": "0.0.0",',
  "    },",
  "  },",
  '  "packages": {',
  '    "@acme/api": ["@acme/api@workspace:apps/api"],',
  "",
  '    "@acme/format": ["@acme/format@workspace:libs/format"],',
  "",
  '    "@acme/logger": ["@acme/logger@workspace:libs/logger"],',
  "",
  '    "@acme/web": ["@acme/web@workspace:apps/web"],',
  "",
  '    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA=="],',
  "  }",
  "}",
  "",
].join("\n");

const chart = (): string =>
  `${bunAdapter.renderImporterBlock({
    packageRoot: "libs/chart",
    packageName: "@acme/chart",
    packageVersion: "0.0.0",
    dependencies: { "@acme/format": "workspace:*" },
    devDependencies: {},
    lockfileText: lockfile,
    workspaceRoots: { "@acme/format": "libs/format" },
  })}\n\n`;

describe("the bun adapter", () => {
  test("declares the commands and names the runtime actually uses", () => {
    expect(bunAdapter.id).toBe("bun");
    expect(bunAdapter.lockfileName).toBe("bun.lock");
    // Membership lives in the root manifest, so that manifest *is* the
    // workspace file. A `null` here would make the scaffolder skip the
    // registration entirely rather than report it as unnecessary.
    expect(bunAdapter.workspaceManifestName).toBe("package.json");
    expect(bunAdapter.installCommand()).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(bunAdapter.lockfileOnlyCommand()).toEqual(["bun", "install", "--lockfile-only"]);
    expect(bunAdapter.linkVersion("apps/web", "libs/chart")).toBe("workspace:libs/chart");
    expect(bunAdapter.declaredVersion!('{"packageManager":"bun@1.3.14"}')).toBe("1.3.14");
    expect(bunAdapter.declaredVersion!('{"packageManager":"pnpm@9.0.0"}')).toBeUndefined();
    expect(bunAdapter.declaredVersion!("not json")).toBeUndefined();
  });

  test("reads a composite importer: the workspaces entry and the packages link together", () => {
    // The failure this pins is a block that carries only the manifest half.
    // Splicing that alone leaves a `workspaces` entry with no workspace link
    // behind it — a lockfile bun rewrites, on a plan the audit called applied.
    const block = bunAdapter.importerBlock(lockfile, "apps/web")!;
    expect(block).toContain('    "apps/web": {');
    expect(block).toContain('    "@acme/web": ["@acme/web@workspace:apps/web"],');
    expect(block.endsWith("\n\n")).toBe(true);

    // The root is keyed `""`, is addressed as `.`, and has no packages entry.
    const root = bunAdapter.importerBlock(lockfile, ".")!;
    expect(root).toContain('    "": {');
    expect(root).not.toContain("workspace:");
    expect(bunAdapter.importerBlock(lockfile, "")).toBe(root);

    expect(bunAdapter.importerBlock(lockfile, "libs/nope")).toBeUndefined();
    // A neighbouring entry must not be absorbed: `apps/api` is a two-field
    // entry immediately before `apps/web`, and a parser that ran to the next
    // key would swallow it.
    expect(bunAdapter.importerBlock(lockfile, "apps/api")).toBe(
      ['    "apps/api": {', '      "name": "@acme/api",', '      "version": "0.0.0",', "    },", '    "@acme/api": ["@acme/api@workspace:apps/api"],', "", ""].join("\n"),
    );
  });

  test("renders a block from the manifest, and refuses one it cannot key", () => {
    const block = chart();
    expect(block).toBe([
      '    "libs/chart": {',
      '      "name": "@acme/chart",',
      '      "version": "0.0.0",',
      '      "dependencies": {',
      '        "@acme/format": "workspace:*",',
      "      },",
      "    },",
      '    "@acme/chart": ["@acme/chart@workspace:libs/chart"],',
      "",
      "",
    ].join("\n"));

    // bun writes no `version` for the root even when the root manifest has one,
    // and no `packages` entry for it at all. Rendering either produces a file
    // the next install rewrites.
    const rootBlock = bunAdapter.renderImporterBlock({
      packageRoot: ".",
      packageName: "fixture-workspace",
      packageVersion: "1.2.3",
      dependencies: {},
      devDependencies: {},
      lockfileText: lockfile,
      workspaceRoots: {},
    });
    expect(rootBlock).toBe(['    "": {', '      "name": "fixture-workspace",', "    },"].join("\n"));

    // The `packages` entry is keyed by the package's name, so a caller that
    // does not supply one is asking for a block that cannot be written. It
    // refuses rather than keying the entry by its directory.
    expect(() =>
      bunAdapter.renderImporterBlock({
        packageRoot: "libs/chart",
        dependencies: {},
        devDependencies: {},
        lockfileText: lockfile,
        workspaceRoots: {},
      }),
    ).toThrow("without its package name");
  });

  test("inserts both halves at their sorted positions, and is idempotent", () => {
    const block = chart();
    const inserted = bunAdapter.insertImporter(lockfile, "libs/chart", block);

    // `workspaces` is sorted by directory; `packages` by package name. The two
    // orders disagree here, which is the point: `libs/chart` sorts after
    // `apps/web` while `@acme/chart` sorts before it.
    expect(inserted.indexOf('    "apps/web": {')).toBeLessThan(inserted.indexOf('    "libs/chart": {'));
    expect(inserted.indexOf('    "libs/chart": {')).toBeLessThan(inserted.indexOf('    "libs/format": {'));
    expect(inserted.indexOf('    "@acme/api": [')).toBeLessThan(inserted.indexOf('    "@acme/chart": ['));
    expect(inserted.indexOf('    "@acme/chart": [')).toBeLessThan(inserted.indexOf('    "@acme/format": ['));

    // The blank line between `packages` entries is part of the format.
    expect(inserted).toContain('    "@acme/api": ["@acme/api@workspace:apps/api"],\n\n    "@acme/chart":');
    expect(inserted).toContain('    "@acme/chart": ["@acme/chart@workspace:libs/chart"],\n\n    "@acme/format":');

    expect(bunAdapter.importerBlock(inserted, "libs/chart")).toBe(block);
    expect(bunAdapter.insertImporter(inserted, "libs/chart", block)).toBe(inserted);
    expect(bunAdapter.lockfileImporterHash(inserted, "libs/chart")).toBe(hashText(block));
    expect(bunAdapter.lockfileImporterHash(lockfile, "libs/chart")).toBeUndefined();
  });

  test("inserting last in packages keeps the blank line on the right side of the entry", () => {
    // `zzz` sorts after `left-pad`, so its entry is appended. The separator has
    // to go *before* it — appended after it, the map would end with a blank
    // line bun does not write.
    const block = `${bunAdapter.renderImporterBlock({
      packageRoot: "libs/zzz",
      packageName: "zzz",
      packageVersion: "0.0.0",
      dependencies: {},
      devDependencies: {},
      lockfileText: lockfile,
      workspaceRoots: {},
    })}\n\n`;
    const inserted = bunAdapter.insertImporter(lockfile, "libs/zzz", block);
    expect(inserted).toContain('"],\n\n    "zzz": ["zzz@workspace:libs/zzz"],\n  }\n}\n');
    expect(bunAdapter.importerBlock(inserted, "libs/zzz")).toBe(block);
  });

  test("replaces and deletes both halves, restoring the original bytes", () => {
    const block = chart();
    const inserted = bunAdapter.insertImporter(lockfile, "libs/chart", block);
    expect(bunAdapter.applyImporter(inserted, "libs/chart", "", "delete")).toBe(lockfile);
    expect(() => bunAdapter.applyImporter(lockfile, "libs/chart", "", "delete")).toThrow("no importer block to delete");

    const wired = bunAdapter.addBlockDependency(bunAdapter.importerBlock(inserted, "apps/web")!, "@acme/chart", "workspace:*", "workspace:libs/chart");
    const replaced = bunAdapter.replaceImporter(inserted, "apps/web", wired);
    expect(bunAdapter.importerBlock(replaced, "apps/web")).toBe(wired);
    // Replacing must not disturb the `packages` half it did not change.
    expect(replaced).toContain('    "@acme/web": ["@acme/web@workspace:apps/web"],');
    expect(() => bunAdapter.replaceImporter(lockfile, "libs/nope", wired)).toThrow("no importer block to replace");
  });

  test("adds a dependency in sorted order, once, creating the section it belongs in", () => {
    const block = bunAdapter.importerBlock(lockfile, "apps/web")!;
    const wired = bunAdapter.addBlockDependency(block, "@acme/chart", "workspace:*", "workspace:libs/chart");
    expect(wired.indexOf('"@acme/chart"')).toBeLessThan(wired.indexOf('"@acme/logger"'));
    expect(bunAdapter.addBlockDependency(wired, "@acme/chart", "workspace:*", "workspace:libs/chart")).toBe(wired);

    // An entry with no dependency map at all has to grow one, in bun's order:
    // `dependencies` before `devDependencies`, both before the closing brace.
    const bare = bunAdapter.importerBlock(lockfile, "libs/logger")!;
    const dev = bunAdapter.addBlockDependency(bare, "@acme/chart", "workspace:*", "workspace:libs/chart", "dev");
    expect(dev).toBe([
      '    "libs/logger": {',
      '      "name": "@acme/logger",',
      '      "version": "0.0.0",',
      '      "devDependencies": {',
      '        "@acme/chart": "workspace:*",',
      "      },",
      "    },",
      '    "@acme/logger": ["@acme/logger@workspace:libs/logger"],',
      "",
      "",
    ].join("\n"));

    // Promotion to runtime moves the entry rather than declaring it twice, and
    // the emptied `devDependencies` map goes with it.
    const promoted = bunAdapter.addBlockDependency(dev, "@acme/chart", "workspace:*", "workspace:libs/chart");
    expect(promoted).toContain('      "dependencies": {');
    expect(promoted).not.toContain('      "devDependencies": {');
    expect(bunAdapter.addBlockDependency(promoted, "@acme/chart", "workspace:*", "workspace:libs/chart")).toBe(promoted);
  });

  test("adds a declared dependency set and prunes one back out", () => {
    const bare = bunAdapter.importerBlock(lockfile, "libs/format")!;
    const wired = bunAdapter.addBlockDependencies(bare, {
      packageRoot: "libs/format",
      dependencies: { "@acme/logger": "workspace:*" },
      devDependencies: { "left-pad": "1.3.0" },
      lockfileText: lockfile,
      workspaceRoots: { "@acme/logger": "libs/logger" },
    });
    expect(wired).toContain('        "@acme/logger": "workspace:*",');
    expect(wired).toContain('        "left-pad": "1.3.0",');
    expect(wired.indexOf('"dependencies"')).toBeLessThan(wired.indexOf('"devDependencies"'));

    const pruned = bunAdapter.removeBlockDependency(wired, "left-pad");
    expect(pruned).not.toContain("left-pad");
    expect(pruned).not.toContain('"devDependencies"');
    expect(bunAdapter.removeBlockDependency(pruned, "absent")).toBe(pruned);
    expect(bunAdapter.removeBlockDependency(pruned, "@acme/logger")).toBe(bare);
  });

  test("refuses importer states it would have to guess about", () => {
    const optional = [
      '    "apps/web": {',
      '      "name": "@acme/web",',
      '      "optionalDependencies": {',
      '        "@acme/chart": "workspace:*",',
      "      },",
      "    },",
      "",
      "",
    ].join("\n");
    expect(() => bunAdapter.addBlockDependency(optional, "@acme/chart", "workspace:*", "")).toThrow("optionalDependencies");

    const peer = optional.replace("optionalDependencies", "peerDependencies");
    expect(() => bunAdapter.addBlockDependency(peer, "@acme/chart", "workspace:*", "")).toThrow("peerDependencies");

    const duplicate = [
      '    "apps/web": {',
      '      "name": "@acme/web",',
      '      "dependencies": {',
      '        "@acme/chart": "workspace:*",',
      "      },",
      '      "devDependencies": {',
      '        "@acme/chart": "workspace:*",',
      "      },",
      "    },",
      "",
      "",
    ].join("\n");
    expect(() => bunAdapter.addBlockDependency(duplicate, "@acme/chart", "workspace:*", "")).toThrow("more than one dependency section");
    expect(() => bunAdapter.removeBlockDependency(duplicate, "@acme/chart")).toThrow("more than one dependency section");

    // A field this module does not recognise is a refusal, not a line to step
    // over: counted as part of whichever map preceded it, a splice would move,
    // duplicate, or drop it while believing it understood the entry.
    const unfamiliar = [
      '    "apps/web": {',
      '      "name": "@acme/web",',
      '      "peerDependenciesMeta": {',
      '        "@acme/chart": {},',
      "      },",
      "    },",
      "",
      "",
    ].join("\n");
    expect(() => bunAdapter.addBlockDependency(unfamiliar, "@acme/chart", "workspace:*", "")).toThrow("unfamiliar bun.lock workspace field");

    // And a lockfile with no `workspaces` map at all is not a lockfile this
    // adapter can read, however well-formed the JSON is.
    expect(() => bunAdapter.importerBlock('{\n  "lockfileVersion": 1,\n}\n', ".")).toThrow(LockfileError);
  });

  test("reports importer dependencies the packages map does not resolve", () => {
    expect(bunAdapter.missingResolutions(lockfile)).toEqual([]);

    // `packages` keys are name chains, not `name@version` ids, so this is an
    // existence check: the resolution *disagreeing* with the range is what
    // regenerate-and-compare catches instead.
    const incomplete = lockfile.replace('    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA=="],\n', "");
    expect(bunAdapter.missingResolutions(incomplete)).toEqual([
      "apps/web declares left-pad@1.3.0, and the lockfile has no packages entry for it",
    ]);

    // A dependency hoisting could not satisfy at the top level is resolved
    // under the owning workspace's own chain. Reporting that as missing would
    // make the check fire on lockfiles bun itself wrote.
    const chained = lockfile.replace(
      '    "left-pad": ["left-pad@1.3.0"',
      '    "@acme/web/left-pad": ["left-pad@1.3.0"',
    );
    expect(bunAdapter.missingResolutions(chained)).toEqual([]);
  });

  test("lists workspace packages from the root manifest, refusing globs it cannot walk", async () => {
    const root = fixtureRepo({ "package.json": '{"name":"fixture","workspaces":["libs/*"]}\n' });
    for (const [dir, name] of [["libs/one", "@acme/one"], ["libs/two", "@acme/two"]] as const) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name }));
    }
    await expect(bunAdapter.listPackages(root)).resolves.toEqual([
      { name: "@acme/one", dir: "libs/one" },
      { name: "@acme/two", dir: "libs/two" },
    ]);

    const object = fixtureRepo({ "package.json": '{"name":"fixture","workspaces":{"packages":["libs/deep/**"]}}\n' });
    await expect(bunAdapter.listPackages(object)).rejects.toThrow("bun workspace glob is not yet ported: libs/deep/**");

    const duplicate = fixtureRepo({ "package.json": '{"name":"fixture","workspaces":["libs/*"]}\n' });
    for (const dir of ["libs/one", "libs/two"]) {
      mkdirSync(join(duplicate, dir), { recursive: true });
      writeFileSync(join(duplicate, dir, "package.json"), '{"name":"@acme/duplicate"}\n');
    }
    await expect(bunAdapter.listPackages(duplicate)).rejects.toThrow("declared by both libs/one and libs/two");

    const none = fixtureRepo({ "package.json": '{"name":"fixture"}\n' });
    await expect(bunAdapter.listPackages(none)).resolves.toEqual([]);
  });

  test("registers membership in the root manifest only when the globs do not already cover it", () => {
    const multiline = ['{', '  "name": "fixture",', '  "workspaces": [', '    "apps/*",', '    "libs/*"', "  ]", "}", ""].join("\n");
    expect(bunAdapter.workspaceManifestEdit(multiline, "libs/chart")).toEqual({ kind: "already-satisfied" });

    const added = bunAdapter.workspaceManifestEdit(multiline, "vendor/chart");
    expect(added.kind).toBe("changed");
    if (added.kind !== "changed") return;
    // Still valid JSON, still sorted, and the entry that used to be last has
    // gained the comma it now needs.
    expect(JSON.parse(added.contents)).toEqual({ name: "fixture", workspaces: ["apps/*", "libs/*", "vendor/chart"] });
    expect(added.contents).toContain('    "libs/*",\n    "vendor/chart"\n');
    expect(bunAdapter.workspaceManifestEdit(added.contents, "vendor/chart")).toEqual({ kind: "already-satisfied" });

    // Inserting before an existing entry leaves every other line alone.
    const early = bunAdapter.workspaceManifestEdit(multiline, "a-vendor/chart");
    expect(early).toMatchObject({ kind: "changed" });
    if (early.kind === "changed") expect(early.contents).toContain('    "a-vendor/chart",\n    "apps/*",');

    const inline = '{\n  "name": "fixture",\n  "workspaces": ["apps/*"]\n}\n';
    const inlined = bunAdapter.workspaceManifestEdit(inline, "vendor/chart");
    expect(inlined).toEqual({ kind: "changed", contents: '{\n  "name": "fixture",\n  "workspaces": ["apps/*", "vendor/chart"]\n}\n' });

    // A shape the splicer cannot read is an unmet precondition, never a
    // silently skipped registration: the package would be invisible to bun.
    expect(bunAdapter.workspaceManifestEdit('{\n  "name": "fixture"\n}\n', "libs/chart")).toEqual({
      kind: "unmet-precondition",
      reason: "the root package.json declares no workspaces field",
    });
    expect(bunAdapter.workspaceManifestEdit('{\n  "workspaces": {\n    "packages": [\n      "apps/*"\n    ]\n  }\n}\n', "libs/chart")).toMatchObject({
      kind: "unmet-precondition",
    });
  });
});
