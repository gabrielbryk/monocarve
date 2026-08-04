/**
 * Path-keyed artifacts are exact journal work, not an opaque post-apply hook.
 *
 * Each negative case below names a plausible failure: config drift changes the
 * command's bytes, a command exits after touching its artifact, or a command
 * writes somewhere it never declared. All must refuse without residue.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig, type MonocarveUserConfig } from "../src/config.ts";
import { pathMigrationOperations } from "../src/plan/build.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import type { ExtractionManifest, MigratePathKeysOperation, PlanOperation } from "../src/plan/manifest.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { readUtf8Artifact, runPathMigrationCommand } from "../src/transaction/path-migrations.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";

const FIRST = "apps/api/src/alpha.ts";
const SECOND = "apps/api/src/beta.ts";
const FIRST_TARGET = "libs/values/src/alpha.ts";
const SECOND_TARGET = "libs/values/src/beta.ts";
const BASELINE = "quality/path-baseline.json";
const COMMAND = "workspace-baseline-migrator";

const MIGRATOR = `
const request = await Bun.stdin.json();
const artifact = JSON.parse(request.contents);
for (const move of request.moves) {
  if (!Object.prototype.hasOwnProperty.call(artifact.paths, move.source)) continue;
  artifact.paths[move.target] = artifact.paths[move.source];
  delete artifact.paths[move.source];
}
process.stdout.write(JSON.stringify(artifact, null, 2) + "\\n");
`;

function files() {
  return {
    ".gitignore": "ignored-output.txt\n",
    "package.json": '{"name":"fixture","private":true,"type":"module"}\n',
    "apps/api/tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}\n',
    [FIRST]: "export const alpha = 1;\n",
    [SECOND]: "export const beta = 2;\n",
    [BASELINE]: `${JSON.stringify({ paths: { [FIRST]: 10, [SECOND]: 20 } }, null, 2)}\n`,
    "scripts/migrate-paths.ts": MIGRATOR,
    "scripts/fail-after-write.ts": `
await Bun.write("ignored-output.txt", "residue\\n");
process.stderr.write("migration exploded\\n");
process.exit(7);
`,
    "scripts/write-elsewhere.ts": `
const request = await Bun.stdin.json();
await Bun.write("ignored-output.txt", "residue\\n");
const artifact = JSON.parse(request.contents);
for (const move of request.moves) {
  if (!Object.prototype.hasOwnProperty.call(artifact.paths, move.source)) continue;
  artifact.paths[move.target] = artifact.paths[move.source];
  delete artifact.paths[move.source];
}
process.stdout.write(JSON.stringify(artifact, null, 2) + "\\n");
`,
    "scripts/invalid-output.ts": "process.stdout.write(Uint8Array.from([255, 254]));\n",
    "scripts/echo-contents.ts": `
const request = await Bun.stdin.json();
process.stdout.write(request.contents);
`,
  };
}

function fixtureCommand(root: string, script = "migrate-paths.ts"): string {
  return `bun '${join(root, "scripts", script)}'`;
}

function configFor(root: string, command = fixtureCommand(root)) {
  return fixtureConfig(root, {
    pathMigrations: { artifacts: [{ path: BASELINE, command, triggers: ["^apps/api/src/"] }] },
    gates: { package: [], project: [], workspace: [] },
    transaction: { allowDirtyPaths: ["scripts/migrate-paths.ts"] },
  });
}

function moves(root: string): PlanOperation[] {
  return [
    {
      kind: "move",
      source: SECOND,
      target: SECOND_TARGET,
      preconditionHash: hashText(read(root, SECOND)),
      resultHash: hashText(read(root, SECOND)),
    },
    {
      kind: "move",
      source: FIRST,
      target: FIRST_TARGET,
      preconditionHash: hashText(read(root, FIRST)),
      resultHash: hashText(read(root, FIRST)),
    },
  ];
}

function migration(root: string, command = fixtureCommand(root)): { config: ReturnType<typeof configFor>; operation: MigratePathKeysOperation } {
  const config = configFor(root, command);
  const operation = pathMigrationOperations(config, new WorkspaceContext(config, root), moves(root))[0]!;
  return { config, operation };
}

function manifest(root: string, operation: MigratePathKeysOperation): ExtractionManifest {
  const sourceHash = hashText(read(root, FIRST));
  const operations: PlanOperation[] = [
    { kind: "move", source: FIRST, target: FIRST_TARGET, preconditionHash: sourceHash, resultHash: sourceHash },
    operation,
  ];
  return {
    schemaVersion: 2,
    planId: "path-migration-fixture",
    createdAt: "2024-01-02T03:04:05.000Z",
    generator: { name: "fixture-engine", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("fixture-graph"),
    application: "api",
    target: { packageName: "@acme/values", packageRoot: "libs/values", entrypoint: "src/index.ts", requiredExports: [] },
    source: { files: [FIRST], tests: [], sccs: { "scc-alpha": [FIRST] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [FIRST]: sourceHash },
    operations,
    consumers: [],
    generatedFiles: [],
    changedFiles: [BASELINE, FIRST, FIRST_TARGET].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 1, applicationLinesAfter: 0, consumers: 0 },
    commits: {
      plan: { subject: "chore(@acme/values): compile extraction plan path-migration-fixture" },
      move: { subject: "refactor(@acme/values): move 1 files into libs/values" },
      wiring: { subject: "refactor(@acme/values): wire @acme/values into the workspace" },
    },
    gates: { package: [], project: [], workspace: [] },
  };
}

function landManifest(root: string, plan: ExtractionManifest): string {
  const path = "plans/path-migration-fixture.json";
  write(root, path, `${JSON.stringify(plan, null, 2)}\n`);
  fixtureGit(root, "add", "--", path);
  fixtureGit(root, "commit", "-qm", plan.commits.plan!.subject);
  return path;
}

describe("path-keyed artifact migrations", () => {
  afterEach(cleanupFixtures);

  test("sorts and hashes the exact move map deterministically", () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const context = new WorkspaceContext(config, root);
    const forward = pathMigrationOperations(config, context, moves(root))[0]!;
    const reverse = pathMigrationOperations(config, context, [...moves(root)].reverse())[0]!;

    expect(forward.moves).toEqual([
      { source: FIRST, target: FIRST_TARGET },
      { source: SECOND, target: SECOND_TARGET },
    ]);
    expect(reverse).toEqual(forward);
  });

  test("rejects duplicate artifact paths at the config boundary", () => {
    const base: MonocarveUserConfig = {
      applications: [{ name: "api", sourceRoot: "apps/api/src", tsconfig: "apps/api/tsconfig.json" }],
      packageRoots: ["libs"],
      scaffoldTemplates: { packageJson: { contents: "{}" } },
      pathMigrations: {
        artifacts: [
          { path: BASELINE, command: COMMAND },
          { path: BASELINE, command: "another-command" },
        ],
      },
    };
    expect(() => parseConfig(base)).toThrow(`duplicate artifact path ${BASELINE}`);
  });

  test("validation refuses command/config divergence and an omitted configured migration", () => {
    const root = fixtureRepo(files());
    const { config, operation } = migration(root);
    const base = manifest(root, { ...operation, moves: [{ source: FIRST, target: FIRST_TARGET }] });
    const drifted = { ...base, operations: [base.operations[0]!, { ...base.operations[1]!, command: "different" }] };
    expect(validatePlan(drifted, { config, rootDir: root }).issues.map((issue) => issue.rule)).toContain(
      "path-migration-config",
    );
    const omitted = { ...base, operations: [base.operations[0]!], changedFiles: [FIRST, FIRST_TARGET].sort() };
    expect(validatePlan(omitted, { config, rootDir: root }).issues.map((issue) => issue.rule)).toContain(
      "path-migration-config",
    );
  });

  test("apply refuses changed command output by result hash and rolls back", async () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const firstMove = moves(root)[1]!;
    const operation = pathMigrationOperations(config, new WorkspaceContext(config, root), [firstMove])[0]!;
    const plan = manifest(root, operation);
    const manifestPath = landManifest(root, plan);
    write(root, "scripts/migrate-paths.ts", MIGRATOR.replace("artifact.paths[move.source];", "artifact.paths[move.source] + 1;"));

    await expect(applyPlan({ config, rootDir: root, manifest: plan, manifestPath, commit: true, skipSimulation: true })).rejects.toThrow(
      "hash mismatch",
    );
    expect(read(root, FIRST)).toContain("alpha");
    expect(existsSync(join(root, FIRST_TARGET))).toBe(false);
    expect(read(root, BASELINE)).toContain(FIRST);
  });

  test("a command failure removes ignored residue and restores the journal", async () => {
    const root = fixtureRepo(files());
    const good = migration(root);
    const command = fixtureCommand(root, "fail-after-write.ts");
    const operation = { ...good.operation, command };
    const config = configFor(root, command);

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, operation) })).rejects.toThrow(
      "failed (exit 7)",
    );
    expect(existsSync(join(root, "ignored-output.txt"))).toBe(false);
    expect(read(root, BASELINE)).toContain(FIRST);
    expect(read(root, FIRST)).toContain("alpha");
    expect(existsSync(join(root, FIRST_TARGET))).toBe(false);
  });

  test("isolates ignored relative writes during planning and real apply", async () => {
    const root = fixtureRepo(files());
    const command = fixtureCommand(root, "write-elsewhere.ts");
    const config = configFor(root, command);
    const firstMove = moves(root)[1]!;
    // This planner invocation runs the command once. Its ignored write belongs
    // to the disposable command cwd, never the workspace.
    const operation = pathMigrationOperations(config, new WorkspaceContext(config, root), [firstMove])[0]!;
    expect(existsSync(join(root, "ignored-output.txt"))).toBe(false);
    const plan = manifest(root, operation);
    const manifestPath = landManifest(root, plan);

    const result = await applyPlan({ config, rootDir: root, manifest: plan, manifestPath, commit: true, skipSimulation: true });
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "ignored-output.txt"))).toBe(false);
    expect(fixtureGit(root, "status", "--short")).toBe("");
  });

  test("refuses a path-keyed artifact that is not valid UTF-8 text", () => {
    const root = fixtureRepo(files());
    writeFileSync(join(root, BASELINE), Uint8Array.from([0xff, 0xfe, 0xfd]));
    fixtureGit(root, "add", "--", BASELINE);
    fixtureGit(root, "commit", "-qm", "test: seed non-UTF-8 artifact");
    const config = configFor(root);
    expect(() => pathMigrationOperations(config, new WorkspaceContext(config, root), [moves(root)[1]!])).toThrow(
      "is not valid UTF-8 text",
    );
  });

  test("refuses migration output that is not valid UTF-8 text", () => {
    const root = fixtureRepo(files());
    const config = configFor(root, fixtureCommand(root, "invalid-output.ts"));
    expect(() => pathMigrationOperations(config, new WorkspaceContext(config, root), [moves(root)[1]!])).toThrow(
      "migration output",
    );
  });

  test("preserves a UTF-8 BOM through the command protocol", () => {
    const root = fixtureRepo(files());
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"paths":{}}\n')]);
    writeFileSync(join(root, BASELINE), raw);
    const contents = readUtf8Artifact(join(root, BASELINE), BASELINE);
    expect(contents.codePointAt(0)).toBe(0xfeff);

    const result = runPathMigrationCommand(
      root,
      { path: BASELINE, command: fixtureCommand(root, "echo-contents.ts"), moves: [] },
      contents,
      10_000,
    );
    expect(Buffer.from(result, "utf8")).toEqual(raw);
  });

  test("the byte-fidelity proof fails when a migrated artifact is changed afterward", async () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const firstMove = moves(root)[1]!;
    const operation = pathMigrationOperations(config, new WorkspaceContext(config, root), [firstMove])[0]!;
    const plan = manifest(root, operation);
    await executeJournal({ config, treeRoot: root, manifest: plan });

    write(root, BASELINE, '{"tampered":true}\n');
    const audit = auditPlanSync({ config, rootDir: root, manifest: plan, skipCompileProof: true });
    expect(audit.byteFidelity.passed).toBe(false);
    expect(audit.byteFidelity.failures[0]).toContain("path-keyed artifact does not match");
  });
});
