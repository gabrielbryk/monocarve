/**
 * The bun splice, against the installed bun binary.
 *
 * Every other bun proof compares the splice to this tool's own idea of the
 * format. This one asks bun. `bun.lock` is JSONC whose formatting carries
 * meaning — trailing commas, the blank line between `packages` entries, the
 * order of the dependency maps, `""` for the workspace root — and none of that
 * is documented anywhere the adapter could have read it. It was measured, so it
 * has to keep being measured.
 *
 * Skipped, not passed, when bun is not on PATH.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bunAdapter } from "../src/adapters/bun.ts";
import { verifyLockfile } from "../src/transaction/lockfile-verify.ts";
import { cleanupFixtures, scratchDirectory } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/bun-monorepo");
const LOCKFILE = bunAdapter.lockfileName;

/** Absent means every case below reports as skipped, not as passed. */
const BUN = Bun.which("bun");

type FrozenLockfileOnlyBehavior = "rewrites" | "preserves";

function frozenLockfileOnlyBehavior(version: string): FrozenLockfileOnlyBehavior {
  if (version.startsWith("1.3.")) return "rewrites";
  if (version.startsWith("1.4.")) return "preserves";
  throw new Error(`unmeasured Bun version for frozen lockfile behavior: ${version}`);
}

/** A copy of the committed fixture, outside every repository. */
function workspace(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** The package a plan would scaffold, as its two-part importer block. */
function chartBlock(lockfileText: string): string {
  return `${bunAdapter.renderImporterBlock({
    packageRoot: "libs/chart",
    packageName: "@acme/chart",
    packageVersion: "0.0.0",
    dependencies: { "@acme/format": "workspace:*" },
    devDependencies: {},
    lockfileText,
    workspaceRoots: { "@acme/format": "libs/format" },
  })}\n\n`;
}

/** Land the extraction the way the journal does: manifests, then the lockfile. */
function landExtraction(root: string): string {
  mkdirSync(join(root, "libs/chart"), { recursive: true });
  writeFileSync(
    join(root, "libs/chart/package.json"),
    `${JSON.stringify({ name: "@acme/chart", version: "0.0.0", private: true, type: "module", dependencies: { "@acme/format": "workspace:*" } }, null, 2)}\n`,
    { flag: "w" },
  );
  const web = JSON.parse(readFileSync(join(root, "apps/web/package.json"), "utf8")) as { dependencies: Record<string, string> };
  web.dependencies = Object.fromEntries(Object.entries({ ...web.dependencies, "@acme/chart": "workspace:*" }).sort());
  writeFileSync(join(root, "apps/web/package.json"), `${JSON.stringify(web, null, 2)}\n`);

  const baseline = readFileSync(join(root, LOCKFILE), "utf8");
  const inserted = bunAdapter.insertImporter(baseline, "libs/chart", chartBlock(baseline));
  const wired = bunAdapter.addBlockDependency(
    bunAdapter.importerBlock(inserted, "apps/web")!,
    "@acme/chart",
    "workspace:*",
    bunAdapter.linkVersion("apps/web", "libs/chart"),
  );
  const spliced = bunAdapter.replaceImporter(inserted, "apps/web", wired);
  writeFileSync(join(root, LOCKFILE), spliced);
  return spliced;
}

function verify(root: string): ReturnType<typeof verifyLockfile> {
  return verifyLockfile({
    workspacePath: root,
    lockfileName: LOCKFILE,
    command: bunAdapter.lockfileOnlyCommand(),
    completeness: bunAdapter.missingResolutions,
    timeoutMs: 90_000,
  });
}

describe("lockfile verification against real bun", () => {
  afterEach(cleanupFixtures);

  test.skipIf(BUN === null)(
    "the committed fixture lockfile is the one bun writes",
    () => {
      // The fixture is the baseline every other case splices into, and it is a
      // file in the tree that nothing regenerates. If it had drifted from bun's
      // output, every byte-identity case below would be comparing two files
      // bun rewrites the same way, and would pass while proving nothing.
      const root = workspace();
      const result = verify(root);
      expect(result.differences).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(bunAdapter.missingResolutions(readFileSync(join(root, LOCKFILE), "utf8"))).toEqual([]);
    },
    120_000,
  );

  test.skipIf(BUN === null)(
    "the composite splice is byte-identical to what bun writes for the same workspace",
    () => {
      const root = workspace();
      const spliced = landExtraction(root);

      // The two halves landed in two differently-sorted regions, which is the
      // whole reason the block is composite.
      expect(spliced.indexOf('    "apps/web": {')).toBeLessThan(spliced.indexOf('    "libs/chart": {'));
      expect(spliced.indexOf('    "@acme/chart": [')).toBeLessThan(spliced.indexOf('    "@acme/format": ['));

      const result = verify(root);
      expect(result.differences).toBeUndefined();
      expect(result.ok).toBe(true);
      // The verification restores the planned bytes; the gates after it must
      // see the lockfile the plan declared, not a repaired copy.
      expect(readFileSync(join(root, LOCKFILE), "utf8")).toBe(spliced);
    },
    120_000,
  );

  test.skipIf(BUN === null)(
    "a splice missing the packages half diverges, so the case above is not vacuous",
    () => {
      // The negative for the test above. Dropping the workspace link is the
      // defect a manifest-only block would have shipped: the file still parses,
      // still installs a tree that looks right, and bun puts the entry back.
      const root = workspace();
      const spliced = landExtraction(root);
      const halved = spliced.replace('    "@acme/chart": ["@acme/chart@workspace:libs/chart"],\n\n', "");
      expect(halved).not.toBe(spliced);
      writeFileSync(join(root, LOCKFILE), halved);

      const result = verify(root);
      expect(result.ok).toBe(false);
      expect(result.differences?.join("\n")).toContain('"@acme/chart": ["@acme/chart@workspace:libs/chart"],');
    },
    120_000,
  );

  test.skipIf(BUN === null)(
    "a mis-sorted splice diverges, which is the divergence a membership check cannot express",
    () => {
      const root = workspace();
      const spliced = landExtraction(root);
      // Same lines, wrong place: move the workspace entry past the sibling it
      // sorts before. Nothing is missing, so only a byte comparison sees it.
      const entry = bunAdapter.importerBlock(spliced, "libs/chart")!.split("\n").slice(0, -3).join("\n");
      const moved = spliced.replace(`${entry}\n`, "").replace('    "libs/logger": {', `${entry}\n    "libs/logger": {`);
      expect(moved).not.toBe(spliced);
      expect(moved.length).toBe(spliced.length);
      writeFileSync(join(root, LOCKFILE), moved);

      const result = verify(root);
      expect(result.ok).toBe(false);
      expect(result.differences?.[0]).toContain(LOCKFILE);
    },
    120_000,
  );

  test.skipIf(BUN === null)(
    "--frozen-lockfile behavior for --lockfile-only is version-aware",
    () => {
      // Measured because the adapter's command depends on it: a reader could
      // reasonably assume the two flags together are a check, and build a
      // verification on the exit code instead of on the bytes. They are not a
      // check. Bun 1.3 rewrites a divergent lockfile and exits 0; Bun 1.4
      // preserves it and still exits 0. Comparing bytes is the only behavior
      // that answers whether the splice is canonical, which is what
      // `verifyLockfile` does.
      const root = workspace();
      const baseline = readFileSync(join(root, LOCKFILE), "utf8");
      const divergent = baseline.replace('    "@acme/format": ["@acme/format@workspace:libs/format"],\n\n', "");
      expect(divergent).not.toBe(baseline);
      writeFileSync(join(root, LOCKFILE), divergent);

      const run = Bun.spawnSync([BUN!, "install", "--lockfile-only", "--frozen-lockfile"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode).toBe(0);
      const after = readFileSync(join(root, LOCKFILE), "utf8");
      if (frozenLockfileOnlyBehavior(Bun.version) === "rewrites") expect(after).not.toBe(divergent);
      else expect(after).toBe(divergent);
    },
    120_000,
  );
});
