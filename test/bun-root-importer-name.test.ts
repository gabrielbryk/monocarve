/**
 * The one field in a `bun.lock` workspace entry the manifest does not decide.
 *
 * bun writes `"name"` into a `workspaces` entry when it *creates* it, and
 * leaves the identity fields exactly as it found them when it *updates* one.
 * A root entry that reached the file without a name therefore never gains one,
 * however many installs follow — which is why one real repository's lockfile
 * has no root name while its own regenerated lockfile does. Rendering the
 * manifest's name unconditionally made the projection disagree with that file
 * forever, and `verifyPackageImporters` reported the disagreement as a
 * repository-postcondition failure on every plan, before any plan had done
 * anything.
 *
 * The first two cases measure the rule against the installed bun rather than
 * restating this tool's belief about it; they use a workspace with no registry
 * dependencies so bun never needs the network. The rest pin the projection to
 * what those two measured, including the negative that keeps the root's
 * special case from leaking into every other member.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bunAdapter } from "../src/adapters/bun.ts";
import { cleanupFixtures, scratchDirectory } from "./support/fixture-repo.ts";

const LOCKFILE = bunAdapter.lockfileName;

/** Absent means the measured cases report as skipped, not as passed. */
const BUN = Bun.which("bun");

const MEMBER = `${JSON.stringify({ name: "@acme/lib", version: "0.0.0" }, null, 2)}\n`;

/** A workspace whose every dependency is a workspace link, so bun stays offline. */
function bunWorkspace(rootExtras: Record<string, unknown> = {}): string {
  const root = join(scratchDirectory(), "workspace");
  mkdirSync(join(root, "libs/lib"), { recursive: true });
  writeRootManifest(root, rootExtras);
  writeFileSync(join(root, "libs/lib/package.json"), MEMBER);
  return root;
}

function writeRootManifest(root: string, extras: Record<string, unknown>): void {
  const manifest = { name: "probe", version: "0.9.0", private: true, workspaces: ["libs/*"], ...extras };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function runBun(root: string): void {
  const run = Bun.spawnSync([BUN!, "install", "--lockfile-only"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`bun install --lockfile-only failed: ${run.stderr.toString()}`);
}

function lockfile(root: string): string {
  return readFileSync(join(root, LOCKFILE), "utf8");
}

/** The `""` entry's own lines, which is where the name would be. */
function rootEntry(text: string): string {
  const start = text.indexOf('    "": {');
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf("\n    }", start));
}

describe("what bun actually does with the root entry's name", () => {
  afterEach(cleanupFixtures);

  test.skipIf(BUN === null)(
    "writes the root name when it creates the entry",
    () => {
      const root = bunWorkspace({ dependencies: { "@acme/lib": "workspace:*" } });

      runBun(root);

      expect(rootEntry(lockfile(root))).toContain('"name": "probe"');
    },
    120_000,
  );

  test.skipIf(BUN === null)(
    "never adds the root name back to an entry that arrived without one",
    () => {
      // The discriminator. Same manifest, same bun, same command as the case
      // above — the only difference is that an entry already exists, and it has
      // no name. bun rewrites its dependencies and leaves the identity alone,
      // so a projection that insisted on the manifest's name would be demanding
      // a byte no install will ever produce.
      const root = bunWorkspace();
      runBun(root);
      expect(rootEntry(lockfile(root))).toContain('"name": "probe"');
      writeFileSync(join(root, LOCKFILE), lockfile(root).replace('    "": {\n      "name": "probe",\n    },', '    "": {},'));
      writeRootManifest(root, { dependencies: { "@acme/lib": "workspace:*" } });

      runBun(root);

      const entry = rootEntry(lockfile(root));
      expect(entry).toContain('"@acme/lib": "workspace:*"');
      expect(entry).not.toContain('"name"');
    },
    120_000,
  );
});

describe("the projection mirrors the lockfile's root entry", () => {
  afterEach(cleanupFixtures);

  // Shaped like the repository that exposed this: a root entry with dependency
  // sections and no name. Both variants are multi-line, because that is what
  // bun writes for a root that declares anything at all.
  const lock = (rootLines: readonly string[]): string => [
    "{",
    '  "lockfileVersion": 1,',
    '  "workspaces": {',
    ...rootLines,
    '    "libs/lib": {',
    '      "name": "@acme/lib",',
    '      "version": "0.0.0",',
    "    },",
    "  },",
    "}",
    "",
  ].join("\n");
  const ROOT_DEPENDENCIES = [
    '      "dependencies": {',
    '        "@acme/lib": "workspace:*",',
    "      },",
  ];
  const named = lock(['    "": {', '      "name": "probe",', ...ROOT_DEPENDENCIES, "    },"]);
  const anonymous = lock(['    "": {', ...ROOT_DEPENDENCIES, "    },"]);
  const rootless = lock([]);

  const renderRoot = (lockfileText: string, packageName: string | undefined = "probe"): string =>
    bunAdapter.renderImporterBlock({
      packageRoot: ".",
      ...(packageName === undefined ? {} : { packageName }),
      packageVersion: "0.9.0",
      dependencies: { "@acme/lib": "workspace:*" },
      devDependencies: {},
      lockfileText,
      workspaceRoots: { "@acme/lib": "libs/lib" },
    });

  test("emits the name when the lockfile's root entry carries one", () => {
    expect(renderRoot(named)).toContain('"name": "probe"');
  });

  test("omits it when the root entry has none, and needs no package name to do so", () => {
    expect(renderRoot(anonymous)).not.toContain('"name"');
    expect(renderRoot(anonymous, undefined)).not.toContain('"name"');
  });

  test("emits it when there is no root entry to mirror, which is a creation", () => {
    expect(renderRoot(rootless)).toContain('"name": "probe"');
  });

  test("both root shapes round-trip against what the lockfile already holds", () => {
    // Exactly the comparison `verifyPackageImporters` makes. Before the fix the
    // anonymous case differed by one line, and every plan on such a repository
    // failed its repository postconditions.
    for (const text of [named, anonymous]) {
      expect(`${renderRoot(text)}\n\n`).toBe(bunAdapter.importerBlock(text, ".")!);
    }
  });

  test("a member importer is unconditional, so the root's special case cannot leak", () => {
    const member = (lockfileText: string) =>
      bunAdapter.renderImporterBlock({
        packageRoot: "libs/lib",
        packageName: "@acme/lib",
        packageVersion: "0.0.0",
        dependencies: {},
        devDependencies: {},
        lockfileText,
        workspaceRoots: { "@acme/lib": "libs/lib" },
      });
    // The root entry has no name in `anonymous`; the member's still must.
    for (const text of [named, anonymous]) {
      expect(member(text)).toContain('"name": "@acme/lib"');
      expect(member(text)).toContain('"@acme/lib@workspace:libs/lib"');
    }
    expect(() =>
      bunAdapter.renderImporterBlock({
        packageRoot: "libs/lib",
        packageVersion: "0.0.0",
        dependencies: {},
        devDependencies: {},
        lockfileText: anonymous,
        workspaceRoots: {},
      }),
    ).toThrow("without its package name");
  });
});

describe("a real repository's shipped lockfile", () => {
  afterEach(cleanupFixtures);

  test.skipIf(BUN === null)(
    "an entry bun will not repair still verifies, and the same workspace freshly created still carries the name",
    () => {
      // Both observed cases end to end, in one workspace, through the public
      // adapter surface rather than through the private renderer.
      const root = bunWorkspace({ dependencies: { "@acme/lib": "workspace:*" } });
      runBun(root);
      const created = lockfile(root);
      expect(rootEntry(created)).toContain('"name": "probe"');

      const shipped = created.replace('      "name": "probe",\n', "");
      writeFileSync(join(root, LOCKFILE), shipped);
      runBun(root);
      expect(rootEntry(lockfile(root))).not.toContain('"name"');

      const project = (text: string): string =>
        `${bunAdapter.renderImporterBlock({
          packageRoot: ".",
          packageName: "probe",
          packageVersion: "0.9.0",
          dependencies: { "@acme/lib": "workspace:*" },
          devDependencies: {},
          lockfileText: text,
          workspaceRoots: { "@acme/lib": "libs/lib" },
        })}\n\n`;
      expect(project(created)).toBe(bunAdapter.importerBlock(created, ".")!);
      expect(project(shipped)).toBe(bunAdapter.importerBlock(shipped, ".")!);
    },
    120_000,
  );
});
