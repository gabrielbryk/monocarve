import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { compileMultiFilePreparationManifest } from "../src/prepare/multi-build.ts";
import { simulatePreparation } from "../src/prepare/simulate.ts";
import { planMultiFileSeams, SeamPlanningError } from "../src/seams/index.ts";
import { planSeam } from "../src/seams/plan.ts";
import { analyzeWorkspaceSymbols } from "../src/symbols/workspace.ts";
import { hashJson, stableStringify } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo, read, scratchDirectory } from "./support/fixture-repo.ts";

function write(root: string, path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function workspace(name: string): string {
  const root = join(scratchDirectory(), `multi-seam-${name}`);
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, moduleResolution: "bundler", module: "esnext" }, include: ["src/**/*.ts"] }));
  write(root, "src/a.ts", 'import type { B } from "./b"; export interface A { b: B }\nexport interface LoneA { b: B }\n');
  write(root, "src/b.ts", 'import type { A } from "./a"; export interface B { a: A }\nexport interface LoneB { value: number }\n');
  write(root, "src/use.ts", 'import type { A } from "./a"; export type Used = A;\n');
  return root;
}

function plan(root: string, sourcePaths: readonly string[] = ["src/a.ts", "src/b.ts"]) {
  return planMultiFileSeams({ rootDir: root, tsconfigPath: "tsconfig.json", sourcePaths, affinityForPath: () => "shared" });
}

afterAll(cleanupFixtures);

test("finds one exact cross-file type cycle and keeps disjoint groups separate", () => {
  const result = plan(workspace("cycle"));
  const cycle = result.candidates.find((candidate) => candidate.groups.some((group) => group.name === "A"));
  expect(cycle?.groups.map((group) => group.name).toSorted()).toEqual(["A", "B"]);
  expect(cycle?.cyclic).toBe(true);
  expect(cycle?.sourcePaths).toEqual(["src/a.ts", "src/b.ts"]);
  expect(cycle?.affectedConsumers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ consumerPath: "src/use.ts", groupName: "A" }),
      expect.objectContaining({ consumerPath: "src/a.ts", groupName: "B", referenceCount: 1 }),
    ]),
  );
  expect(result.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceName: "A", targetName: "B", space: "type", confidence: "exact" }),
      expect.objectContaining({ sourceName: "B", targetName: "A", space: "type", confidence: "exact" }),
    ]),
  );
  expect(result.candidates.filter((candidate) => candidate.groups.some((group) => group.name.startsWith("Lone")))).toHaveLength(2);
});

test("canonical source ordering is byte deterministic", () => {
  const root = workspace("order");
  expect(stableStringify(plan(root))).toBe(stableStringify(plan(root, ["src/b.ts", "./src/a.ts"])));
});

test("stale observations refuse without returning plausible candidates", () => {
  const root = workspace("stale");
  const result = planMultiFileSeams({
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    sourcePaths: ["src/a.ts", "src/b.ts"],
    affinityForPath: () => "shared",
    expectedSourceHashes: { "src/a.ts": "0".repeat(64), "src/b.ts": "0".repeat(64) },
  });
  expect(result.candidates).toEqual([]);
  expect(result.blockers.map((blocker) => blocker.code)).toEqual(["stale-source", "stale-source"]);
});

test("refuses unsafe source scope and conflicting placement for an atomic cycle", () => {
  const root = workspace("refusal");
  expect(() => plan(root, ["../a.ts", "src/b.ts"])).toThrow(SeamPlanningError);
  const baseline = plan(root);
  const cycle = baseline.candidates.find((candidate) => candidate.groups.some((group) => group.name === "A"))!;
  const targetPaths = Object.fromEntries(cycle.groupIds.map((id, index) => [id, `src/target-${index}.ts`]));
  const collided = planMultiFileSeams({
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    sourcePaths: ["src/a.ts", "src/b.ts"],
    affinityForPath: () => "shared",
    targetPaths,
  });
  expect(collided.candidates.find((candidate) => candidate.id === cycle.id)?.blockers.map((item) => item.code)).toEqual(["target-collision"]);
});

test("compiler-merged declarations spanning files form one atomic component", () => {
  const root = workspace("merged-global");
  write(root, "src/a.ts", "interface SharedGlobal { left: string }\ninterface SeparateA { value: string }\n");
  write(root, "src/b.ts", "interface SharedGlobal { right: number }\ninterface SeparateB { value: number }\n");
  const result = plan(root);
  const merged = result.mergedSymbols.find((symbol) => symbol.name === "SharedGlobal");
  expect(merged?.groupIds).toHaveLength(2);
  expect(merged?.sourcePaths).toEqual(["src/a.ts", "src/b.ts"]);
  const candidate = result.candidates.find((entry) => entry.groups.some((group) => group.name === "SharedGlobal"));
  expect(candidate?.groups.map((group) => group.name)).toEqual(["SharedGlobal", "SharedGlobal"]);
  expect(candidate?.sourcePaths).toEqual(["src/a.ts", "src/b.ts"]);
  expect(candidate?.cyclic).toBe(true);
});

test("compiles and independently simulates a reviewed cross-file type cycle as one atomic manifest", async () => {
  const root = fixtureRepo({
    "package.json": '{"name":"@acme/workspace","private":true}\n',
    "apps/api/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler" }, include: ["src/**/*.ts"] }),
    "apps/api/src/a.ts": 'import type { B } from "./b"; export interface A { b: B }\nexport const aValue = 1;\n',
    "apps/api/src/b.ts": 'import type { A } from "./a"; export interface B { a: A }\nexport const bValue = 1;\n',
  });
  const config = fixtureConfig(root, {
    preparation: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare cyclic types" } },
  });
  const files = ["apps/api/src/a.ts", "apps/api/src/b.ts"];
  const multi = planMultiFileSeams({ rootDir: root, tsconfigPath: "apps/api/tsconfig.json", sourcePaths: files, affinityForPath: () => "shared" });
  const candidate = multi.candidates.find((item) => item.groups.some((group) => group.name === "A"))!;
  const members = files.map((file) => {
    const analysis = analyzeWorkspaceSymbols({ rootDir: root, tsconfigPath: "apps/api/tsconfig.json", sourcePath: file, affinityForPath: () => "shared" });
    const name = file.endsWith("a.ts") ? "A" : "B";
    const local = analysis.splitCandidates.find((item) => item.names.includes(name))!;
    const targetPath = file.replace(".ts", "-types.ts");
    const seam = planSeam({ analysis, sourceText: read(root, file), candidateId: local.id, targetPath });
    return {
      seam,
      targetPath,
      targetModuleSpecifier: `./${name.toLowerCase()}-types.ts`,
      reviewedGroupIds: seam.movedGroups.map((group) => group.id),
      rendering: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare cyclic types" } },
      rewriteRelativeTypeImport: ({ originalSpecifier }: { originalSpecifier: string }) => ({
        targetSpecifier: originalSpecifier,
        resolvedSourcePath: originalSpecifier === "./a" ? "apps/api/src/a.ts" : "apps/api/src/b.ts",
      }),
    };
  });
  const manifest = compileMultiFilePreparationManifest({
    rootDir: root,
    config,
    baselineCommit: "HEAD",
    graphDigest: hashJson(multi),
    multiSeam: multi,
    candidateId: candidate.id,
    members,
  });
  expect(() =>
    compileMultiFilePreparationManifest({
      rootDir: root,
      config,
      baselineCommit: "HEAD",
      graphDigest: hashJson(multi),
      multiSeam: multi,
      candidateId: candidate.id,
      members: members.slice(0, 1),
    }),
  ).toThrow(/exactly cover/);
  expect(manifest.operations).toHaveLength(2);
  expect(manifest.declarations.map((group) => group.name).toSorted()).toEqual(["A", "B"]);
  expect(manifest.changedFiles).toEqual(["apps/api/src/a-types.ts", "apps/api/src/a.ts", "apps/api/src/b-types.ts", "apps/api/src/b.ts"]);
  const simulation = await simulatePreparation({
    config,
    rootDir: root,
    manifest,
    baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }),
  });
  expect(simulation.ok).toBe(true);
  expect(simulation.audit?.passed).toBe(true);
}, 30_000);
