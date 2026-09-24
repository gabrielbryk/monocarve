/**
 * Walk order is a fact about the tree, never about the filesystem storing it.
 *
 * `readdirSync` returns entries in whatever order the directory happens to hold
 * them — hash order on ext4 and tmpfs, creation order on some others — so any
 * inventory built straight from it is a machine-dependent answer wearing a
 * repository-shaped disguise. The determinism invariant forbids that: same repo
 * + same commit + same config must produce the same bytes on every machine.
 *
 * The proof therefore has to *force* the disorder. Enumerating a real directory
 * twice proves nothing (a real filesystem is stable, so an unsorted walk agrees
 * with itself), and creating files in non-lexical order proves nothing reliably
 * either — whether that yields a non-lexical listing is precisely the ambient
 * fact under test, and on a filesystem that happens to hand back sorted entries
 * the check would pass with the sort deleted. So `readdirSync` is stubbed to
 * return every listing in *descending* name order: with two or more entries
 * that is never the ascending answer, on any filesystem, so these tests fail
 * deterministically the moment either sort is removed. Each one first asserts
 * the stub is actually biting, so a pass can never be vacuous.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseConfig } from "../src/config.ts";

// Captured before the module is mocked, so the stub can delegate to the real
// implementation instead of to itself.
const realReaddir = realFs.readdirSync;
const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = realFs;

type ListingOrder = "filesystem" | "descending";
let listingOrder: ListingOrder = "filesystem";

function entryName(entry: unknown): string {
  return typeof entry === "string" ? entry : String((entry as { name: string }).name);
}

await mock.module("node:fs", () => ({
  ...realFs,
  readdirSync: (...args: unknown[]) => {
    const entries = (realReaddir as (...a: unknown[]) => unknown[])(...args);
    if (listingOrder === "filesystem" || !Array.isArray(entries)) return entries;
    return [...entries].toSorted((left, right) => {
      const a = entryName(left);
      const b = entryName(right);
      return a < b ? 1 : a > b ? -1 : 0;
    });
  },
}));

// Imported after the stub is installed, so the walker resolves the patched
// binding rather than the real one.
const { sourceFiles } = await import("../src/util/files.ts");
const { WorkspaceContext } = await import("../src/plan/context.ts");

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "monocarve-order-")));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

beforeEach(() => {
  listingOrder = "filesystem";
});

afterAll(() => {
  listingOrder = "filesystem";
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("source enumeration order", () => {
  test("sourceFiles follows an explicit workspace extension policy", () => {
    const root = tree({ "widget.component": "export const widget = 1;\n", "ignored.ts": "export const ignored = 1;\n" });

    expect(sourceFiles(root, undefined, [".component"])).toEqual([join(root, "widget.component")]);
  });

  test("sourceFiles is lexical no matter what order the filesystem reports", () => {
    // Written in an order that is neither lexical nor the answer, so nothing
    // here can accidentally agree with the expectation.
    const root = tree({
      "zebra.ts": "export const z = 1;\n",
      "nested/widget.tsx": "export const w = 1;\n",
      "alpha.ts": "export const a = 1;\n",
      "nested/inner/deep.mts": "export const d = 1;\n",
      "beta/gamma.js": "export const g = 1;\n",
      "notes.md": "not a module\n",
      "node_modules/vendor/index.ts": "export const v = 1;\n",
    });
    const expected = [
      join(root, "alpha.ts"),
      join(root, "beta/gamma.js"),
      join(root, "nested/inner/deep.mts"),
      join(root, "nested/widget.tsx"),
      join(root, "zebra.ts"),
    ];

    expect(sourceFiles(root)).toEqual(expected);

    listingOrder = "descending";
    // The stub bites: the walker's own view of the directory is now reversed,
    // so an unsorted walk cannot help but report a different order.
    expect(realFs.readdirSync(root).map(entryName)).toEqual(["alpha.ts", "beta", "nested", "node_modules", "notes.md", "zebra.ts"].reverse());
    expect(sourceFiles(root)).toEqual(expected);
  });

  test("the workspace inventory is canonical across roots, not per root", () => {
    // `firstPartyRoots` sorts before `packageRoots` here, so the concatenation
    // of independently-walked roots is out of order even when every root is
    // internally sorted. That is what the inventory's own sort answers.
    const root = tree({
      "apps/web/src/main.ts": "export const main = 1;\n",
      "apps/web/src/widgets/chart.ts": "export const chart = 1;\n",
      "apps/web/scripts/fixture.ts": "export const fixture = 1;\n",
      "libs/format/src/index.ts": "export const format = 1;\n",
      "core/telemetry.ts": "export const telemetry = 1;\n",
    });
    const config = parseConfig(
      {
        applications: [
          {
            name: "web",
            sourceRoot: "apps/web/src",
            consumerRoots: ["apps/web/scripts"],
            tsconfig: "apps/web/tsconfig.json",
            packageName: "@acme/web",
            compositionRoots: [],
          },
        ],
        packageRoots: ["libs"],
        firstPartyRoots: ["core"],
        packageScope: "@acme/",
        scaffoldTemplates: { entrypoint: "src/index.ts", packageJson: { contents: '{ "name": "{package}" }\n' } },
      },
      "<source-order fixture>",
    );
    const expected = ["apps/web/scripts/fixture.ts", "apps/web/src/main.ts", "apps/web/src/widgets/chart.ts", "core/telemetry.ts", "libs/format/src/index.ts"];

    expect(new WorkspaceContext(config, root).repositorySources()).toEqual(expected);

    listingOrder = "descending";
    expect(realFs.readdirSync(join(root, "apps/web/src")).map(entryName)).toEqual(["widgets", "main.ts"]);
    expect(new WorkspaceContext(config, root).repositorySources()).toEqual(expected);
  });
});
