/**
 * The concrete failure this feature exists to fix: a retained consumer that
 * names a moved source through `resolve(import.meta.dir, path)` (directly, or
 * through the `const read = (path) => readFileSync(resolve(import.meta.dir,
 * path), "utf8")` helper) rather than by importing it. The import graph never
 * sees this reference, so without this feature the plan builds, applies, and
 * audits clean while the consumer's literal still names the pre-move path —
 * and the very next `read(...)` throws ENOENT.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { buildPlanSync, serializeManifest } from "../src/plan/build.ts";
import { findStaticFsReferences } from "../src/plan/static-fs-references.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory, write } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

const READER = "apps/api/src/chart-fixture-reader.ts";
const DONOR = "apps/web/src/widgets/chart.ts";
const UNRELATED_LITERAL = "./server.ts";
const DONOR_LITERAL = "../../web/src/widgets/chart.ts";

function readerSource(): string {
  return [
    'import { readFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    "",
    'const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");',
    "",
    `export const chartSource = read("${DONOR_LITERAL}");`,
    `export const serverSource = read("${UNRELATED_LITERAL}");`,
    "",
  ].join("\n");
}

function loopReaderSource(): string {
  return [
    'import { readFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    '',
    'const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");',
    '',
    `for (const path of ["${DONOR_LITERAL}"]) read(path);`,
    '',
  ].join("\n");
}

function standaloneWorkspace(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });
  fixtureGit(root, "init", "-q", "-b", "work");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed workspace");
  return root;
}

describe("static filesystem reference consumers", () => {
  afterAll(cleanupFixtures);

  test("rewrites a resolve(import.meta.dir, ...) literal that survives outside the import graph", async () => {
    const root = standaloneWorkspace();
    write(root, READER, readerSource());
    fixtureGit(root, "add", "-A");
    fixtureGit(root, "commit", "-qm", "test: add static fs reference consumer");

    const { config } = await loadConfig({ cwd: root });
    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const candidate = buildPortfolio({ config, graph }).candidates.find((entry) => entry.eligible && entry.files.includes(DONOR));
    expect(candidate).toBeDefined();

    const manifest = buildPlanSync({
      config,
      rootDir: root,
      graph,
      candidate: candidate!,
      baselineCommit: graph.commit!,
      packageName: "@acme/chart-fsref",
    });

    const operation = manifest.operations.find(
      (candidateOperation) => candidateOperation.kind === "rewrite-fs-reference" && candidateOperation.file === READER,
    );
    expect(operation).toBeDefined();
    expect(operation?.kind).toBe("rewrite-fs-reference");
    if (operation?.kind !== "rewrite-fs-reference") throw new Error("unreachable");
    expect(operation.rewrites).toHaveLength(1);
    expect(operation.rewrites[0]?.from).toBe(DONOR_LITERAL);
    expect(operation.rewrites[0]?.donor).toBe(DONOR);
    // Never guessed: the unrelated `./server.ts` read resolves to a file this
    // plan never moves, so it must not appear in the operation at all.
    expect(operation.rewrites.some((rewrite) => rewrite.from === UNRELATED_LITERAL)).toBe(false);

    const manifestPath = "plans/chart-fsref.json";
    write(root, manifestPath, serializeManifest(manifest));
    fixtureGit(root, "add", "--", manifestPath);
    fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);

    const applied = readFileSync(join(root, READER), "utf8");
    // The applied literal is real: it resolves, from the reader's own
    // directory, to exactly where the donor landed.
    const expectedLiteral = relative(dirname(resolve(root, READER)), resolve(root, "libs/chart-fsref/src/widgets/chart.ts")).replaceAll("\\", "/");
    expect(applied).toContain(`read("${expectedLiteral}")`);
    expect(applied).not.toContain(DONOR_LITERAL);
    // The unrelated literal was never a reference to a moved file and is
    // untouched, byte for byte.
    expect(applied).toContain(`read("${UNRELATED_LITERAL}")`);

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
  }, 300_000);

  test("rewrites literals forwarded through a for-of binding", () => {
    const source = loopReaderSource();
    expect(findStaticFsReferences(source, "/workspace/apps/api/src/reader.ts").map((match) => match.literal)).toEqual([DONOR_LITERAL]);
  });

  test("finds direct resolve literals forwarded through a for-of binding", () => {
    const source = ['import { resolve } from "node:path";', `for (const path of ["${DONOR_LITERAL}"]) resolve(import.meta.dir, path);`].join("\n");
    expect(findStaticFsReferences(source, "/workspace/apps/api/src/reader.ts").map((match) => match.literal)).toEqual([DONOR_LITERAL]);
  });
});
